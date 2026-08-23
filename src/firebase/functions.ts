import * as functions from 'firebase-functions/v1' // v6+ root export is 2nd gen; ssr is deployed as 1st gen

// the kit build is esm (build/handler.js, served behind the express middleware stack as in
// server.mjs), so it is loaded dynamically; the Function constructor keeps tsc from rewriting
// import() into require() when compiling this module to commonjs (see build_ts in package.json)
const dynamicImport = new Function('p', 'return import(p)') as (p: string) => Promise<any>

let app // express app with the kit handler mounted, created on first request
exports.ssr = functions.https.onRequest(async (request, response) => {
  request.baseUrl = '' // fixes 404s with 'firebase serve'
  if (!app) {
    const base = new URL('../../', 'file://' + __filename).href
    const [{ middleware }, { handler }] = await Promise.all([
      dynamicImport(base + 'src/server/app.mjs'),
      dynamicImport(base + 'build/handler.js'),
    ])
    middleware.use(handler)
    app = middleware
  }
  app(request, response)
})
