import * as functions from 'firebase-functions/v1' // v6+ root export is 2nd gen; ssr is deployed as 1st gen

let app: any = null // express app with the kit handler mounted, created on first request
export const ssr = functions.https.onRequest(async (request, response) => {
  request.baseUrl = '' // fixes 404s with 'firebase serve'
  if (!app) {
    // NOTE the function deliberately never calls enableLocalProxy: the arbitrary-target proxy is
    // not merely refused here, it is never constructed or mounted (round-19 finding 6 — denial by
    // socket address was a property of the current frontend topology, not of this code)
    const base = new URL('../../', import.meta.url).href
    const [{ middleware }, { handler }] = await Promise.all([
      import(base + 'src/server/app.mjs'),
      import(base + 'build/handler.js'),
    ])
    middleware.use(handler)
    app = middleware
  }
  app(request, response)
})
