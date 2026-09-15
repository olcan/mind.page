// the vendored cdn origins of the e2e gate (vault design mind_task_agents 9.7, the offline app
// gate; the route is src/server/vendor.mjs): when a server runs with VENDOR_DIR set (a lane server
// of tests/e2e/run.sh; never the cloud function, never a plain `node server.mjs`), the shell it
// serves names every cdn asset as `/vendor/<host>/<path>` instead of `https://<host>/<path>`, and
// carries a rewriter that turns the absolute cdn urls item code assigns at runtime
// (`script.src = 'https://cdn.jsdelivr.net/...'` in mind.items' load.js and todoer.js, a fetch)
// into the same route, so the gate's browsers, whose resolver refuses every remote host
// (playwright.config.ts), load them from the lane server. no dependencies: this module is bundled
// into the kit server (src/hooks.server.js) and read by the unit tests. fonts are not vendored:
// the Google Fonts css and its font files stay remote and fail in every gate run alike (online or
// not), so the lanes render with the fallback fonts consistently (text snapshots only, no
// screenshot golden); vendoring the font subsets is a backfill if a row ever needs the typography
export const VENDOR_HOSTS = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com']

const ORIGINS = new RegExp(`https://(${VENDOR_HOSTS.map(host => host.replace(/\./g, '\\.')).join('|')})/`, 'g')

// the same substitution over any text: the shell, a css body
export const vendorText = text => text.replace(ORIGINS, '/vendor/$1/')

// the runtime rewriter, injected right after <head> so it precedes every loader: the url
// properties and setAttribute of script/link/image elements and fetch's string input
export const REWRITER = `<script data-vendor-rewriter>(function(){var hosts=${JSON.stringify(VENDOR_HOSTS)};function vendor(url){if(typeof url!='string')return url;for(var i=0;i<hosts.length;i++){var origin='https://'+hosts[i]+'/';if(url.indexOf(origin)==0)return '/vendor/'+hosts[i]+'/'+url.slice(origin.length)}return url}
var pairs=[[HTMLScriptElement,'src'],[HTMLLinkElement,'href'],[HTMLImageElement,'src']];for(var j=0;j<pairs.length;j++)(function(proto,name){var d=Object.getOwnPropertyDescriptor(proto,name);Object.defineProperty(proto,name,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){d.set.call(this,vendor(v))}})})(pairs[j][0].prototype,pairs[j][1]);
var set=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){return set.call(this,name,name=='src'||name=='href'?vendor(value):value)};
var f=window.fetch;window.fetch=function(input,init){return f.call(this,typeof input=='string'?vendor(input):input,init)}})()</script>`

// the shell a vendoring server serves: origins substituted, the rewriter injected once
export const vendorShell = html => vendorText(html).replace(/<head[^>]*>/, tag => tag + REWRITER)
