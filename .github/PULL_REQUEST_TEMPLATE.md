## What and why
<!-- What does this change, and why? Link the issue if there is one. -->

## How it was checked
- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run i18n:check` (no new hard-coded text)
- [ ] `cargo test --bin orchestra` (if Rust changed)
- [ ] Tried in the app or in demo mode (describe what you did)

## Checklist
- [ ] New or changed UI text is in both `locales/en` and `locales/es`
- [ ] New tests can fail (security-relevant checks were verified by planting the bug)
- [ ] No secrets in logs, state, backups or arguments
- [ ] Files are UTF-8 with LF line endings
- [ ] `CHANGELOG.md` and the docs are updated if behavior changed
