import { createRequire } from 'node:module'
globalThis.window = { _shortcut_hosts: [] }
globalThis._ = createRequire(process.cwd() + '/package.json').resolve ? createRequire(import.meta.url)('lodash') : null
const { urlRegExp } = await import(process.cwd() + '/src/util.js')

const LINE = 'Rafal Wilinski on X: "Jev is now in charge of this account\'s humor https://t.co/ojSOHeMFT2" / X [gmail](https://mail.google.com/mail/u/0/#inbox/1a0b6fc15733b648)'

// exactly what Editor.svelte's updateTextDivs feeds highlightLinks: _.escape(line)
const escaped = _.escape(LINE)
console.log('ESCAPED INPUT :', escaped)

// Editor.svelte:171-179 highlightLinks (verbatim)
const highlightLinks = text =>
  text
    .replace(/\[(?:[^\]]|\\\])*[^\\]\]\((?:[^\)]|\\\))*[^\\)]\)/g, link => `<span class="link">${link}</span>`)
    .replace(urlRegExp({ suffix: /[^\s)<>:,."]/ }), (m, pfx, href) => pfx + `<span class="link">${href}</span>`)
console.log('highlightLinks:', highlightLinks(escaped))

// Editor.svelte:342 comment link_urls
const link_urls = text => text.replace(urlRegExp({ suffix: /[^\s)<>:,."]/ }), (m, pfx, url) => `${pfx}<a>${url}</a>`)
console.log('comment link_urls:', link_urls(escaped))

// what the raw (round 1+2) path does, for contrast
const raw = LINE.replace(urlRegExp(), (m, pfx, url) => `${pfx}«${url}»`)
console.log('RAW replaceURLs rule:', raw)

// &amp; in a query string, escaped
console.log('AMP escaped:', _.escape('see https://example.com/q?a=1&b=2 end').replace(urlRegExp(), (m,p,u)=>`${p}«${u}»`))
console.log('AMP escaped trailing:', _.escape('see https://example.com/a&').replace(urlRegExp(), (m,p,u)=>`${p}«${u}»`))
