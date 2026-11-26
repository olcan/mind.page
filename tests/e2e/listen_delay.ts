// A DIAGNOSTIC, not part of the gate: holds back the reloaded page's first streaming Listen
// response, the condition under which the Firestore emulator lost the initial acknowledgement of a
// large replay while the SDK's long-polling auto-detection was on (the vault's issue on the admin
// lane's reload row has the account). The admin lane's large-account row uses it only when
// MIND_LISTEN_DELAY is set. With emulatorFirestoreSettings (src/e2e_lanes.js) taken out, and a
// handshake faster than a quarter of the hold, that row then fails at its confirmation; with a
// slow handshake the detection does not fire and the diagnostic shows nothing
import http from 'http'
import type { Page } from '@playwright/test'

export type ListenDelay = {
  delayed: boolean // the route took the first `GET ...AID=0&CI=0`
  delivered: boolean // the whole burst (through the global NO_CHANGE after CURRENT) was fulfilled
  fellBack: boolean // the page asked again with `AID=0&CI=1`: the switch to long polling
  welcomeTimeouts: string[] // the app's lines of a welcome on an unconfirmed corpus (not a failure by themselves)
  stop: () => Promise<void>
}

// routes the page's FIRST `GET .../Firestore/Listen/channel?...AID=0&CI=0` through this process:
// the request is made from node (so the emulator sends its whole replay), read until the target's
// CURRENT and the global NO_CHANGE after it have arrived as complete length-prefixed frames, held
// for `holdMs`, then fulfilled with that burst
export async function delayFirstListen(page: Page, holdMs = 400): Promise<ListenDelay> {
  const pattern = /Firestore\/Listen\/channel/
  const state: ListenDelay = { delayed: false, delivered: false, fellBack: false, welcomeTimeouts: [], stop: () => page.unroute(pattern).catch(() => {}) }
  page.on('console', m => {
    if (/corpus settled: timeout|welcome hooks on an unconfirmed corpus/.test(m.text())) state.welcomeTimeouts.push(m.text())
  })
  await page.route(pattern, async route => {
    const req = route.request()
    const url = req.url()
    if (req.method() === 'GET' && url.includes('AID=0') && url.includes('CI=1')) state.fellBack = true
    if (state.delayed || req.method() !== 'GET' || !url.includes('AID=0') || !url.includes('CI=0')) return route.continue()
    state.delayed = true
    const reqHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers())) if (k.toLowerCase() !== 'accept-encoding') reqHeaders[k] = v
    const upstream = await new Promise<{ status: number; headers: Record<string, string>; body: Buffer; complete: boolean }>((resolveUpstream, rejectUpstream) => {
      let settled = false
      let textSoFar = ''
      let sawCurrent = false
      const timer = setTimeout(() => {
        reqOut.destroy()
        fail(new Error('timed out waiting for the emulator\'s first Listen burst'))
      }, 15_000)
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        rejectUpstream(err)
      }
      const finish = (res: http.IncomingMessage, body: Buffer, complete: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          if (!v || k.toLowerCase() === 'transfer-encoding' || k.toLowerCase() === 'content-length') continue
          headers[k] = Array.isArray(v) ? v.join(', ') : v
        }
        reqOut.destroy()
        resolveUpstream({ status: res.statusCode ?? 200, headers, body, complete })
      }
      const reqOut = http.get(url, { headers: reqHeaders }, res => {
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          textSoFar += chunk
          let pos = 0
          let sawGlobalSync = false
          while (pos < textSoFar.length) {
            const nl = textSoFar.indexOf('\n', pos)
            if (nl === -1) break
            const len = Number(textSoFar.slice(pos, nl))
            if (!Number.isFinite(len) || len < 0 || nl + 1 + len > textSoFar.length) break
            const frame = textSoFar.slice(nl + 1, nl + 1 + len)
            pos = nl + 1 + len
            if (frame.includes('"CURRENT"')) sawCurrent = true
            if (sawCurrent && /"targetChange":\{"resumeToken":"[^"]+","readTime":/.test(frame)) sawGlobalSync = true
          }
          if (sawGlobalSync) finish(res, Buffer.from(textSoFar.slice(0, pos), 'utf8'), true)
        })
        res.on('end', () => finish(res, Buffer.from(textSoFar, 'utf8'), false))
        res.on('error', fail)
      })
      reqOut.on('error', fail)
    })
    await new Promise(r => setTimeout(r, holdMs))
    try {
      await route.fulfill({ status: upstream.status, headers: upstream.headers, body: upstream.body })
      state.delivered = upstream.complete
    } catch {
      // (the page gave the request up meanwhile: `delivered` stays false)
    }
  })
  return state
}
