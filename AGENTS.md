# Agent Notes

This repository is a git submodule of a private parent vault. **Read `../../docs/mind_page.md` before any work here** — it is the single authoritative orientation (state, testing, review protocol, settled decisions).

Standalone-context invariants (binding even without the parent):

- Do not deploy, and do not touch production data, without explicit owner instruction.
- Never let a real token or API key into a traced browser context or test output (the e2e gate serves all `olcan/mind.items` traffic locally with a fake token; live tests require exactly `MIND_ITEMS_LIVE=1`).
- `src/routes/index.svelte` is a deliberate monolith: no component extraction or runes migration without a decision recorded in the parent.
