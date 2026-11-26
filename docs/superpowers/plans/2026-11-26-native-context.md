# Native context regression plan

Goal: restore desktop compatibility coverage without recreating Claude's private settings state.

Use a test-only class initializer to capture the real context constructed by Claude's app. Pass that instance to the real renderer and native getter. Preserve strict discovery checks and reject missing or ambiguous instances. No runtime extension changes or release.

- [x] Add failing behavioral tests for old/new/renamed state, private fields, native false, missing/ambiguous contexts, and production gate guarding.
- [x] Instrument the real instance; migrate desktop/startup callers and report adapter diagnostics. Keep native fallback and ownership checks.
- [x] Pin Claude 2.1.332 in CI and test the published VSIX in a separate desktop job, including PRs, so candidate failures cannot mask deployed coverage.
- [ ] Run the full suite, packaged VSIX desktop/startup checks locally, then PR CI. Review and show actual captures before any merge/publication.

Coverage limits: deterministic upstream renderer fixtures, not authenticated replies; Windows/WSL unverified. Existing experimental plan-preview anchor failure is separate and must remain disclosed.

Status: 26 adapter checks, 418 isolated-profile unit tests, and real VS Code 1.147.0 / Claude 2.1.332 desktop (29) and startup (5) checks pass. Review findings covered by failing-then-passing tests; published-job token scoped to download only. PR CI and screenshot delivery remain. Full host suite retains the baseline plan-preview anchor failure against installed Claude 2.1.330.
