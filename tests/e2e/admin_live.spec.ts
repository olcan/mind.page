// live tests (smoke + tool use) for chat provider items (validation-only, NEVER part of the
// deterministic gate): they require the explicit MIND_ITEMS_LIVE=1 opt-in on top of per-provider
// api keys from env (injected into item global_store in the emulator), so an ambient shell key
// cannot silently turn the ordinary gate into paid, network-dependent calls. ollama needs no key
// but is included only when the local server actually responds; providers without keys skip.
// a separate file rather than a row in admin.spec.ts: trace must be off for this test (the
// default retain-on-failure trace would retain page-evaluate arguments and provider request
// headers, i.e. real api keys) and playwright rejected a describe-scoped trace option in this
// suite ("Make it top-level in the test file or put in the configuration file"); file scope is
// also the clean boundary for standalone selection and secret-output isolation. it still runs
// in the admin project lane (see playwright.config.ts).
// see _test_live_smoke and _test_live_tool_use in the items
import { expect, test } from '@playwright/test'
import { install, loadAdmin } from './helpers.js'

test.use({ trace: 'off' })
test.setTimeout(600_000)
// file-level EXACT opt-in: the ordinary gate must not even allocate the page fixture, and a
// stray truthy value like '0' or 'false' must not enable paid/network calls
test.skip(
  process.env.MIND_ITEMS_LIVE !== '1',
  'live validation is explicit: set MIND_ITEMS_LIVE=1 (hosted providers need api keys in env; ollama needs a local server with the gemma3 + qwen3:4b test models)'
)

const LIVE: { item: string; key?: string }[] = [
  { item: 'agent/chat/claude', key: process.env.ANTHROPIC_API_KEY },
  { item: 'agent/chat/gpt', key: process.env.OPENAI_API_KEY },
  { item: 'agent/chat/gemini', key: process.env.GEMINI_API_KEY },
  { item: 'agent/chat/together', key: process.env.TOGETHER_API_KEY },
  { item: 'agent/chat/groq', key: process.env.GROQ_API_KEY },
  { item: 'agent/chat/ollama', key: 'none' }, // local server, no key needed (availability-gated below)
  { item: 'agent/chat/openrouter', key: process.env.OPENROUTER_API_KEY },
]

test('live smokes pass for opted-in providers', async ({ page }) => {
  // ollama's row has no key to gate on: include it only when the local server responds. NOTE
  // reachability is necessary, not sufficient -- the item's live tests also need their models
  // present (gemma3 default for live_smoke, qwen3:4b for live_tool_use); a server without them
  // fails the rows rather than skipping (deliberate: this is explicit opt-in validation)
  const ollama = await fetch('http://localhost:11434/api/version', { signal: AbortSignal.timeout(2_000) })
    .then(r => r.ok)
    .catch(() => false)
  const live = LIVE.filter(p => (p.key == 'none' ? ollama : p.key))
  test.skip(live.length == 0, 'no provider keys in env and no local ollama')
  // NOTE: no blanket page-console relay here -- providers log request details (gemini carries its
  // key in the request url, claude in an x-api-key header), so raw console text can leak real
  // keys into stdout and the html report; the structured non-secret diagnostics below suffice
  await loadAdmin(page) // github interception + fake token are loadAdmin's invariant (helpers.ts)
  // self-sufficient: install #tester (the /test command) and the opted-in providers when absent,
  // instead of assuming admin.spec.ts ran first -- playwright file order within a project is not
  // an ordering contract (observed: this file ran BEFORE admin.spec.ts), and this row must also
  // work standalone under --no-deps
  const exists = (name: string) => page.evaluate(name => window._exists(name), name)
  for (const path of ['tester', ...live.map(p => p.item)]) {
    if (await exists(`#${path}`)) continue // already installed (as a dependency or by admin.spec.ts)
    expect(await install(page, path), `/_install ${path}`).toBeNull()
  }
  // wait for firestore saves so a later page load (e.g. admin.spec.ts running after this file)
  // cannot lose freshly installed items (same save wait as the admin.spec.ts install row)
  await expect
    .poll(() => page.evaluate(() => window.__items.filter(item => !item.savedId).length), { timeout: 120_000 })
    .toBe(0)
  const failures: string[] = []
  const skipped: string[] = LIVE.filter(p => !live.includes(p)).map(p => p.item)
  for (const { item, key } of live) {
    const name = `#${item}`
    expect(await exists(name), name).toBe(true)
    if (key != 'none')
      await page.evaluate(
        ([name, key]) => (((window as any)._item(name).global_store.api_key = key), undefined),
        [name, key] as [string, string]
      )
    // run gated live tests (live_smoke + live_tool_use) via /test <item> live (excluded from
    // default runs); poll for the stored results rather than the completion modal, which can
    // race with the previous provider's still-dismissing modal
    await page.evaluate(
      name => void window._create(`/test ${name} live`, { command: true, return_alerts: true }),
      name
    )
    let polled = false
    try {
      await expect
        .poll(
          () =>
            page.evaluate(name => {
              const tests = (window as any)._item(name)._global_store._tests ?? {}
              return !!(tests.live_smoke && tests.live_tool_use)
            }, name),
          { message: name, timeout: 90_000 }
        )
        .toBe(true)
      polled = true
      const done = page.getByText(/Completed \d+ tests? in \d+ items?\./)
      await expect(done, name).toBeVisible({ timeout: 30_000 })
      await page.getByText('OK', { exact: true }).click()
      await expect(done, name).toBeHidden({ timeout: 30_000 })
    } catch (e) {
      console.log(`${name}: ${polled ? 'modal flow failed' : 'no result in 90s (hang?)'}`)
      // ALLOWLIST diagnostics only -- never item/tester logs or serialized test results: provider
      // items log response errors and request details verbatim (an api error can echo a submitted
      // key fragment; a gemini network error renders the request url with ?key=...), and
      // trace:'off' does not sanitize what this spec explicitly writes to stdout/report
      const diag = await page.evaluate(name => {
        const item = (window as any)._item(name)
        return {
          global_store_keys: Object.keys(item._global_store ?? {}),
          store_keys: Object.keys(item.store ?? {}),
          modal: document.querySelector('.modal')?.textContent?.slice(0, 200),
        }
      }, name)
      console.log(`${name} diagnostics: ${JSON.stringify(diag, null, 1)}`)
      await page.keyboard.press('Escape').catch(() => {}) // dismiss any stuck modal
    }
    const results = await page.evaluate(name => {
      const tests = (window as any)._item(name)._global_store._tests ?? {}
      return { live_smoke: tests.live_smoke, live_tool_use: tests.live_tool_use }
    }, name)
    for (const [test, result] of Object.entries(results)) {
      // allowlist here too: report only ok/ms presence, never the result content (its log field
      // carries the item's eval log, same hazard as above)
      if (!result?.ok) failures.push(`${name} ${test}: ${result ? `failed in ${result.ms ?? '?'}ms` : 'missing result'}`)
      console.log(`${test} ${name}: ${result?.ok ? `ok in ${result.ms}ms` : 'FAILED'}`)
    }
  }
  if (skipped.length) console.log(`live smokes skipped (no key or unreachable): ${skipped.join(', ')}`)
  expect(failures, failures.join('\n')).toEqual([])
})
