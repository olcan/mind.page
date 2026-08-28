# Agent Notes

This repository is developed as a git submodule of a private parent repository (the developer's vault). Agent orientation — current state, testing playbook, review-cycle protocol, settled design decisions — is maintained in the parent at `docs/mind_page.md` (from this directory: `../../docs/mind_page.md`). Read it before making changes here.

Quick facts if the parent is unavailable:

- Gates: `npm run check` (0 errors / 53 warnings baseline), `npm run lint`, `npm run check:tests`, `npm run test:unit`; full browser gate `tests/e2e/run.sh` (builds + Firebase emulators on ports 8080/9099).
- The gate's mind.items install/update seam is local-only: it requires a sibling `../mind.items` checkout (`loadAdmin` fails fast without it), and all `olcan/mind.items` API traffic is served or failed closed locally with a fake token. Live provider tests run only with exactly `MIND_ITEMS_LIVE=1`; never let a real token or API key into a traced browser context or test output.
- `src/routes/index.svelte` is a deliberate monolith; do not extract components or migrate to runes without an explicit decision recorded in the parent repo.
- Do not deploy, and do not touch production data, without explicit owner instruction.
