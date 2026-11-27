// Workaround for the Firestore emulator (cloud-firestore-emulator v1.22.0) WebChannel keep-alive bug:
// `WebChannelForwardingHandler$ForwardHandler.channelRead0` forwards chunked HTTP/1.1 responses for
// `/google.firestore.v1.Firestore/(Listen|Write)/channel` without sending a `Connection: close`
// header, then asynchronously closes the inbound socket via `ChannelFutureListener.CLOSE` after
// writing `LastHttpContent`. Because `Connection: close` is absent, Chromium treats the socket as
// reusable keep-alive; when the 6-connection pool for `127.0.0.1:8080` is busy, Chromium can write
// a subsequent `POST /v1/.../documents:commit` onto that closing socket. Netty can dispatch Copy 1
// to gRPC `Firestore.Commit` before `CLOSE` drops the socket with 0 response bytes; Chromium's
// `HttpNetworkTransaction` then silently retries the `POST` on another socket inside the same XHR,
// hitting `firestore.rules` L29 with `resource == null` (`403 PERMISSION_DENIED: Null value error`).
//
// Routing WebChannel POSTs over non-pooled Node HTTP (`agent: false`, one fresh socket per POST)
// keeps those closing sockets out of Chromium's keep-alive pool (and out of any Node pool), while
// streaming `GET` backchannels and REST RPCs (`:batchGet`, `:commit`) fall through untouched.
import http from 'http'

export type WebChannelRequest = {
  method(): string
  url(): string
  postDataBuffer(): Buffer | null
  allHeaders(): Promise<Record<string, string>>
}

export type WebChannelRoute = {
  request(): WebChannelRequest
  fulfill(response: { status: number; headers: Record<string, string>; body: Buffer }): Promise<void>
  abort(): Promise<void>
  fallback(): Promise<void>
}

export type WebChannelPage = {
  isClosed(): boolean
  once(event: 'close', listener: () => void): unknown
  route(url: RegExp, handler: (route: WebChannelRoute) => unknown): Promise<unknown>
}

export type WebChannelUpstreamResponse = {
  statusCode?: number
  headers: http.IncomingHttpHeaders
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
}

export type WebChannelUpstreamRequest = {
  on(event: 'close', listener: () => void): unknown
  on(event: 'error', listener: (err: Error) => void): unknown
  end(chunk?: Buffer): unknown
  destroy(error?: Error): unknown
}

export type WebChannelTransport = (
  options: http.RequestOptions,
  callback: (res: WebChannelUpstreamResponse) => void
) => WebChannelUpstreamRequest

export async function isolateEmulatorWebChannelPosts(
  page: WebChannelPage,
  host = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080',
  transport: WebChannelTransport = http.request
): Promise<void> {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^http://${escaped}/google\\.firestore\\.v1\\.Firestore/(Listen|Write)/channel(?:\\?|$)`)
  const active = new Set<() => void>()
  let closed = page.isClosed()
  const isClosed = () => closed || page.isClosed()

  const closeActive = () => {
    closed = true
    for (const cancel of active) cancel()
    active.clear()
  }

  const quietIfClosed = async (fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      if (!isClosed()) throw err
    }
  }

  const handler = async (route: WebChannelRoute) => {
    const req = route.request()
    if (req.method() !== 'POST') {
      await quietIfClosed(() => route.fallback())
      return
    }
    if (isClosed()) {
      await quietIfClosed(() => route.abort())
      return
    }
    let rawHeaders: Record<string, string>
    try {
      rawHeaders = await req.allHeaders()
    } catch (err) {
      await quietIfClosed(() => route.abort())
      if (!isClosed()) throw err
      return
    }
    if (isClosed()) {
      await quietIfClosed(() => route.abort())
      return
    }
    const url = new URL(req.url())
    const body = req.postDataBuffer() ?? Buffer.alloc(0)
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(rawHeaders)) {
      const low = k.toLowerCase()
      if (
        low.startsWith(':') ||
        low === 'host' ||
        low === 'content-length' ||
        low === 'connection' ||
        low === 'keep-alive' ||
        low === 'accept-encoding'
      )
        continue
      headers[low] = v
    }
    headers['content-length'] = String(body.length)
    let res: { status: number; headers: Record<string, string>; body: Buffer }
    try {
      res = await new Promise((resolve, reject) => {
        const up = transport(
          {
            hostname: url.hostname,
            port: url.port || undefined,
            path: url.pathname + url.search,
            method: 'POST',
            headers,
            agent: false,
          },
          r => {
            const chunks: Buffer[] = []
            let ended = false
            r.on('data', c => chunks.push(typeof c === 'string' ? Buffer.from(c) : c))
            r.on('end', () => {
              ended = true
              finish()
              const outHeaders: Record<string, string> = {}
              for (const [k, v] of Object.entries(r.headers)) {
                const low = k.toLowerCase()
                if (v === undefined || low === 'transfer-encoding' || low === 'connection' || low === 'keep-alive') continue
                outHeaders[low] = Array.isArray(v) ? v.join(', ') : v
              }
              resolve({ status: r.statusCode ?? 200, headers: outHeaders, body: Buffer.concat(chunks) })
            })
            r.on('error', err => {
              finish()
              reject(err)
            })
            r.on('close', () => {
              if (!ended) {
                finish()
                reject(new Error('upstream response closed'))
              }
            })
          }
        )
        const cancel = () => {
          up.destroy()
          reject(new Error('page closed'))
        }
        const finish = () => active.delete(cancel)
        active.add(cancel)
        up.on('close', finish)
        up.on('error', err => {
          finish()
          reject(err)
        })
        if (isClosed()) {
          finish()
          up.destroy()
          reject(new Error('page closed'))
          return
        }
        up.end(body)
      })
    } catch {
      await quietIfClosed(() => route.abort())
      return
    }
    if (isClosed()) {
      await quietIfClosed(() => route.abort())
      return
    }
    await quietIfClosed(() => route.fulfill(res))
  }

  if (!closed) page.once('close', closeActive)
  await page.route(pattern, handler)
}
