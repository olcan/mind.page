// numeric pwa scope prefixes with an optional display-mode letter, e.g. /2f/ (see src/server/app.js)
export function match(param) {
  return /^\d[fsmb]?$|^[fsmb]$/.test(param)
}
