# 0002: No Remote Code, No Accounts, No Tracking

Status: Accepted
Applies to: ImgFetch 1.1.0
Last verified: 2026-10-22

## Context

ImgFetch is a product rule, not only a technical choice: users install it
to save images from pages they visit, and that job needs no identity, no
server account, and no analytics.
Remote code would also break the Manifest V3 store policies and the
extension page Content Security Policy in `manifest.json`, which allows
scripts from the extension itself only (`script-src 'self'`).

## Decision

Ship all code inside the extension package. Load no remote scripts, fetch
no executable code, and evaluate no remotely supplied strings.

Require no sign in and no account of any kind.
Collect no telemetry and no tracking data. Downloads, settings, history,
and captures stay on the user's device, in browser storage and IndexedDB.
Contact and support run through GitHub Issues, not through any in product
account system.

## Consequences

Every feature must work fully offline once a page's images are reachable.
There is no server component to build, secure, or pay for, and no user
database to protect.
The trade off is accepted: there is no cross device sync, no remote
configuration, and no usage analytics to guide product decisions.
Fixes and string changes ship only with a new extension release.
