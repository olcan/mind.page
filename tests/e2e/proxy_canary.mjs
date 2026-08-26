#!/usr/bin/env node
// Asks the REAL hosting-to-functions path whether it will proxy to an arbitrary backend.
// A source test can only say the function never calls enableLocalProxy (see tests/unit/host.spec.ts);
// this stands up a canary backend and asserts NOTHING reaches it, so a future import-time
// construction or mounting change fails the cloud path itself.
// The invariant is the canary count, not a status code: a routing change could alter the status
// innocently, but must never make the request arrive.
// usage: node tests/e2e/proxy_canary.mjs <hosting-port>
import http from 'http'

const front = Number(process.argv[2] ?? 5050)
let hits = 0
let failure = null
const canary = http.createServer((req, res) => {
  hits++
  console.error(`canary REACHED: ${req.url}`)
  res.end('canary')
})
await new Promise(resolve => canary.listen(0, '127.0.0.1', resolve))
const port = canary.address().port

// every shape the gate distinguishes: no headers at all, a same-origin browser request, and the
// explicit local-tool opt-in. none of them may reach a backend through the cloud function
try {
  for (const headers of [{}, { 'sec-fetch-site': 'same-origin' }, { 'x-mindpage-local-proxy': '1' }])
    // every probe must COMPLETE. resolving on timeout or connection error and then reporting
    // "no cloud proxy" made an untested frontend look like a passing one: a frontend that destroys
    // every socket reproduced exit 0, with the canary unreached only because nothing got through.
    // the timeout bounds the failure; it does not convert it into a pass
    await new Promise((resolve, reject) => {
      const request = http.get(
        { host: '127.0.0.1', port: front, path: `/proxy/http://127.0.0.1:${port}/probe`, headers, timeout: 10_000 },
        response => {
          response.resume()
          response.on('end', resolve)
        }
      )
      request.on('timeout', () => {
        request.destroy()
        reject(new Error(`probe timed out against the frontend (headers: ${JSON.stringify(headers)})`))
      })
      request.on('error', error => reject(new Error(`probe could not reach the frontend: ${error.message}`)))
    })
} catch (error) {
  failure = error // reported after the canary is closed: process.exit would skip the finally
} finally {
  await new Promise(resolve => canary.close(resolve)) // awaited: never leave the port held
}
if (failure) {
  console.error(`FAIL: ${failure.message} — absence of proxying was NOT established`)
  process.exit(1)
}
if (hits) {
  console.error(`FAIL: the cloud function proxied ${hits} request(s) to the canary`)
  process.exit(1)
}
console.log('no cloud proxy: the canary was never reached')
