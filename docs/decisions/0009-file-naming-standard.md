# 0009: File Naming Standard

Status: Accepted
Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Context

Documentation links, validation scripts, and the project structure listing
all refer to files by name. Inconsistent names (mixed case, spaces,
duplicate basenames in different folders) break links, confuse the
structure checker in `scripts/validate.py`, and make a file hard to find
from a reference in an issue or a test failure.

## Decision

Use one standard across the repository:

- Root documents are uppercase: `README.md`, `LICENSE`, `CHANGELOG.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, `PRIVACY.md`, `TERMS.md`, and
  `CODE_OF_CONDUCT.md`.
- Everything under `docs/` is lowercase kebab case, for example
  `docs/user-guide.md`, `docs/security-model.md`, and
  `docs/decisions/0004-full-page-capture-parts-indexeddb.md`.
- Decision records are numbered with a four digit prefix and a kebab case
  title, so they sort in decision order.
- Basenames stay unique across the tree, with two long standing exceptions
  that the validator allows: `README.md` files in separate folders and the
  `messages.json` file inside each `_locales` folder.
- Existing files are not renamed for style alone. A rename needs its own
  change that updates every link and checker reference.

## Consequences

A file name in a doc, a test failure, or an issue points at exactly one
file, and new documents have an obvious correct name and place.
Links stay stable because renames are treated as breaking changes.
The cost is occasional verbosity in lowercase kebab case names, accepted
in exchange for predictable paths on case sensitive file systems.
