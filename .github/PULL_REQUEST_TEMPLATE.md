## Summary

What does this pull request change, and why? Link the issue it addresses, for example "Fixes #123".

## What changed

List the main changes, one per line:

-
-
-

## Checklist

- [ ] The change is focused and matches an agreed issue or a clear bug fix.
- [ ] Syntax checks pass (`node --check` on the files changed).
- [ ] Unit tests pass (`node tests/test-*.mjs`).
- [ ] The i18n checker passes (`node scripts/check-i18n.mjs`).
- [ ] The duplicates checker passes (`node scripts/check-duplicates.mjs`).
- [ ] The static validator passes (`python3 scripts/validate.py`).
- [ ] Tests were added or updated for behavior changes, or this change needs no tests and I have said why above.
- [ ] Documentation was updated where behavior, settings, or limits changed.
- [ ] New user visible strings were added to English and to every other locale in `_locales/`.
- [ ] No new manifest permission was added, or the new permission is justified in `docs/permissions.md`.
- [ ] A `CHANGELOG.md` entry was added if the change is visible to users.
- [ ] No em dashes, no personal data, and no local file paths in any file.

## Notes for reviewers

Anything that needs extra attention: risky areas, decisions you made, or checks you could not run and why.
