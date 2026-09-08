// the e2e stack's LANES (tests/e2e/README.md): one Playwright project per lane, each served by its
// own `server.mjs` on its own port and bound to its own Firebase project id on the SHARED local
// emulators (firebase.json: `singleProjectMode: false`; the emulators apply the security rules
// to every project id), so every lane's Firestore state is its own and all lanes run at once.
// Auth is one shared namespace (the emulator routes api-key sign-ins to its default project),
// holding immutable identity fixtures only (tests/e2e/helpers.ts: adminAuth).
// must be importable from plain node esm without bundling (seed.mjs, playwright.config.ts) and
// from the browser bundle (client-globals.ts), like host.js
export const E2E_BASE_PORT = 3100
// the first lane keeps the base port and the base project id: every single-stack reference
// (serve.sh, the harness config, the server rows' own port) stays valid
export const E2E_LANES = ['chromium', 'admin', 'editor', 'bridge', 'renderer', 'propagation', 'personal', 'editor2', 'contract']
export function lanePort(lane) {
  const index = E2E_LANES.indexOf(lane)
  if (index < 0) throw new Error(`unknown e2e lane ${lane}`)
  return E2E_BASE_PORT + index
}
// whether a served port belongs to the e2e stack (a string or a number; '' for a default port)
export function isLanePort(port) {
  const n = Number(port)
  return Number.isInteger(n) && n >= E2E_BASE_PORT && n < E2E_BASE_PORT + E2E_LANES.length
}
// the project id a lane port maps to: the base project for the first lane, `<base>-e2eN` after
// it; any non-lane port (production, the dev server) maps to the base project
export function laneProject(port, base) {
  if (!isLanePort(port)) return base
  const index = Number(port) - E2E_BASE_PORT
  return index > 0 ? `${base}-e2e${index}` : base
}
