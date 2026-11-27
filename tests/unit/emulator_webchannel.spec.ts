import { EventEmitter } from 'events'
import { expect, test } from '@playwright/test'
import {
  isolateEmulatorWebChannelPosts,
  type WebChannelPage,
  type WebChannelRoute,
  type WebChannelTransport,
  type WebChannelUpstreamRequest,
  type WebChannelUpstreamResponse,
} from '../e2e/emulator_webchannel.js'

const LISTEN_URL = 'http://127.0.0.1:8080/google.firestore.v1.Firestore/Listen/channel?VER=8'

function fakePage() {
  let closed = false
  const closeListeners: (() => void)[] = []
  let registered: ((route: WebChannelRoute) => unknown) | null = null
  const page: WebChannelPage = {
    isClosed: () => closed,
    once(_event, listener) {
      closeListeners.push(listener)
    },
    async route(_url, handler) {
      registered = handler
    },
  }
  return {
    page,
    close() {
      if (closed) return
      closed = true
      for (const fn of closeListeners.splice(0)) fn()
    },
    async dispatch(route: WebChannelRoute) {
      if (!registered) throw new Error('route handler not installed')
      await registered(route)
    },
  }
}

function fakeRoute(opts: {
  method?: string
  url?: string
  body?: string
  allHeaders?: () => Promise<Record<string, string>>
  onFulfill?: () => Promise<void>
}) {
  const actions: string[] = []
  const route: WebChannelRoute = {
    request: () => ({
      method: () => opts.method ?? 'POST',
      url: () => opts.url ?? LISTEN_URL,
      postDataBuffer: () => (opts.body !== undefined ? Buffer.from(opts.body) : Buffer.from('count=0')),
      allHeaders: opts.allHeaders ?? (async () => ({ 'content-type': 'application/x-www-form-urlencoded' })),
    }),
    async fulfill() {
      actions.push('fulfill')
      if (opts.onFulfill) await opts.onFulfill()
    },
    async abort() {
      actions.push('abort')
    },
    async fallback() {
      actions.push('fallback')
    },
  }
  return { route, actions }
}

function fakeUpstream() {
  const emitter = new EventEmitter()
  let sent = 0
  let destroyed = 0
  const req: WebChannelUpstreamRequest = {
    on(event: 'close' | 'error', listener: (...args: any[]) => void) {
      emitter.on(event, listener)
      return req
    },
    end() {
      sent++
    },
    destroy() {
      destroyed++
    },
  }
  return { req, emitter, sent: () => sent, destroyed: () => destroyed }
}

test('page closed while awaiting headers starts no upstream request and aborts the route', async () => {
  const host = fakePage()
  let started = 0
  let sent = 0
  const transport: WebChannelTransport = () => {
    started++
    const up = fakeUpstream()
    const origEnd = up.req.end
    up.req.end = chunk => {
      sent++
      return origEnd(chunk)
    }
    return up.req
  }
  await isolateEmulatorWebChannelPosts(host.page, '127.0.0.1:8080', transport)

  let releaseHeaders!: (headers: Record<string, string>) => void
  const held = fakeRoute({
    allHeaders: () =>
      new Promise<Record<string, string>>(resolve => {
        releaseHeaders = resolve
      }),
  })
  const pending = host.dispatch(held.route)
  expect(started).toBe(0)
  host.close()
  releaseHeaders({ 'content-type': 'application/x-www-form-urlencoded' })
  await pending

  expect(started, 'no upstream request started after page close').toBe(0)
  expect(sent, 'no upstream body sent after page close').toBe(0)
  expect(held.actions, 'closed page aborts the intercepted route once').toEqual(['abort'])

  // a header read that REJECTS after its page closed stays quiet and still aborts once: started on a
  // fresh, live page (on a page already closed the helper aborts before it reads any header)
  const closing = fakePage()
  await isolateEmulatorWebChannelPosts(closing.page, '127.0.0.1:8080', transport)
  let rejectHeaders!: (err: Error) => void
  const closedReject = fakeRoute({
    allHeaders: () =>
      new Promise<Record<string, string>>((_resolve, reject) => {
        rejectHeaders = reject
      }),
  })
  const rejected = closing.dispatch(closedReject.route)
  closing.close()
  rejectHeaders(new Error('Target page closed'))
  await rejected
  expect(started, 'no upstream request started when a closed page rejects headers').toBe(0)
  expect(closedReject.actions, 'a header read rejected after the close aborts the route once').toEqual(['abort'])

  // rejecting allHeaders() on a live page aborts the route AND rejects visibly
  const live = fakePage()
  await isolateEmulatorWebChannelPosts(live.page, '127.0.0.1:8080', transport)
  const liveReject = fakeRoute({ allHeaders: () => Promise.reject(new Error('headers boom')) })
  await expect(live.dispatch(liveReject.route), 'live header error fails visibly').rejects.toThrow('headers boom')
  expect(liveReject.actions, 'live header error still aborts the route once').toEqual(['abort'])
})

test('page closed before send or with an upstream POST in flight destroys it and aborts the route', async () => {
  // (1) close synchronously before up.end(body)
  const beforeSend = fakePage()
  let preSendUp!: ReturnType<typeof fakeUpstream>
  const closeBeforeSendTransport: WebChannelTransport = () => {
    preSendUp = fakeUpstream()
    beforeSend.close()
    return preSendUp.req
  }
  await isolateEmulatorWebChannelPosts(beforeSend.page, '127.0.0.1:8080', closeBeforeSendTransport)
  const r1 = fakeRoute({})
  await beforeSend.dispatch(r1.route)
  expect(preSendUp.sent(), 'no body sent when page closes right before send').toBe(0)
  expect(preSendUp.destroyed(), 'upstream request destroyed when page closes right before send').toBe(1)
  expect(r1.actions, 'route aborted once when page closes right before send').toEqual(['abort'])

  // (2) close while an upstream POST is in flight (never leaves the route hanging)
  const inFlight = fakePage()
  let flightUp!: ReturnType<typeof fakeUpstream>
  let markStarted!: () => void
  const flightStarted = new Promise<void>(resolve => {
    markStarted = resolve
  })
  const hangTransport: WebChannelTransport = () => {
    flightUp = fakeUpstream()
    const origEnd = flightUp.req.end
    flightUp.req.end = chunk => {
      origEnd(chunk)
      markStarted()
    }
    return flightUp.req
  }
  await isolateEmulatorWebChannelPosts(inFlight.page, '127.0.0.1:8080', hangTransport)
  const r2 = fakeRoute({})
  const pending = inFlight.dispatch(r2.route)
  await flightStarted
  expect(flightUp.sent()).toBe(1)
  inFlight.close()
  await pending
  expect(flightUp.destroyed(), 'in-flight upstream request destroyed on page close').toBe(1)
  expect(r2.actions, 'in-flight request ends in abort on page close').toEqual(['abort'])
})

test('live routing errors reject visibly, closed-page fulfillment errors stay quiet, and GET falls through', async () => {
  const okTransport: WebChannelTransport = (_opts, cb) => {
    const up = fakeUpstream()
    const resEmitter = new EventEmitter()
    const res: WebChannelUpstreamResponse = {
      statusCode: 200,
      headers: { 'content-type': 'text/plain' },
      on(event: 'data' | 'end' | 'close' | 'error', listener: (...args: any[]) => void) {
        resEmitter.on(event, listener)
        return res
      },
    }
    up.req.end = () => {
      queueMicrotask(() => {
        cb(res)
        resEmitter.emit('data', Buffer.from('ok'))
        resEmitter.emit('end')
      })
    }
    return up.req
  }

  // (1) live page fulfillment failure rejects visibly and never calls abort afterwards
  const live = fakePage()
  await isolateEmulatorWebChannelPosts(live.page, '127.0.0.1:8080', okTransport)
  const failing = fakeRoute({ onFulfill: () => Promise.reject(new Error('fulfill boom')) })
  await expect(live.dispatch(failing.route), 'live fulfillment failure is visible').rejects.toThrow('fulfill boom')
  expect(failing.actions, 'failing fulfill is not followed by abort').toEqual(['fulfill'])

  // (2) fulfillment error caused by concurrent page close stays quiet
  const closing = fakePage()
  await isolateEmulatorWebChannelPosts(closing.page, '127.0.0.1:8080', okTransport)
  const closedFulfill = fakeRoute({
    onFulfill: async () => {
      closing.close()
      throw new Error('Target page closed')
    },
  })
  await closing.dispatch(closedFulfill.route)
  expect(closedFulfill.actions).toEqual(['fulfill'])

  // (3) non-POST falls through without touching the upstream transport
  let getStarted = 0
  const getPage = fakePage()
  await isolateEmulatorWebChannelPosts(getPage.page, '127.0.0.1:8080', () => {
    getStarted++
    return fakeUpstream().req
  })
  const getRoute = fakeRoute({ method: 'GET' })
  await getPage.dispatch(getRoute.route)
  expect(getStarted, 'GET starts no upstream request').toBe(0)
  expect(getRoute.actions, 'GET ends in fallback').toEqual(['fallback'])
})
