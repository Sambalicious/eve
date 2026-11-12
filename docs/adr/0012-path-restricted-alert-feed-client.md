# 0012. Path-restricted outbound client for Google Alerts feeds

Date: 2026-10-21 (rule list updated 2026-10-22, EPIC-0005 follow-ups batch 2)
Status: Accepted (Candidate decision, 2026-10-22). Proposed by the EPIC-0005 Architect. Complements 0004; leaves the board reader allowlist (`board-http.ts`) unchanged.

## Context

EPIC-0005 reads Google Alerts RSS feeds that the Candidate registers. The feeds live on `www.google.com`, which also serves search, results and `google.com/url` redirect pages. The scope forbids any request to those pages and to linkedin.com (PRD AC 6.1, 6.2, 6.4). Every feed entry links to a `google.com/url` redirect that wraps a LinkedIn URL. The existing board client allows whole hosts, follows no redirects (`redirect: "error"`), and is shared by every board reader.

## Decision

- A new client, `apps/api/src/stack-posts/alert-feed-http.ts`, is the only code in the Stack posts module that may make network requests. ESLint enforces this in `apps/api/eslint.config.js` for `src/stack-posts/**/*.ts`, except this client and spec files. Target rule set (SEC-E5-02, SEC-E5-07, SEC-E5F-01, CR-E5F-04; EPIC-0005 architecture r4):
  - Restricted globals: `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `eval`.
  - Restricted properties: `fetch` on `globalThis`, `global`, `window` and `self`; `process.getBuiltinModule`; `process.binding`; `process.dlopen`.
  - Restricted static imports and re-exports, bare and `node:` forms, with every subpath (`undici/*`): `undici`, `http`, `https`, `http2`, `net`, `tls`, `dns`, `dgram`, `child_process`, `worker_threads`, `module`, `axios`, `got`, `node-fetch`. Also any path containing `node_modules`, and any import of another module's HTTP client (`**/sources/board-http*`, `**/alert-feed-http*`).
  - Restricted syntax: dynamic `import()` unless its source is a plain string literal starting with `./` or `../`, and that literal is also refused when it contains `node_modules`; `require(...)`; `Reflect.get`, `Reflect.apply` and `Reflect.construct` calls; any variable or parameter initialised from `globalThis`, `global`, `window` or `self` (`const g = globalThis`), including destructuring.
  - Core rules: `no-eval`, `no-implied-eval`, `no-new-func`.
  - `stack-posts-lint-guard.spec.ts` lints one probe per entry above and expects its rule ID.
- **ESLint here is defence in depth, not a sandbox.** It stops the realistic accidents (a stray `fetch`, `process.getBuiltinModule("node:https")`, an HTTP library import) and the bypasses listed above. It cannot follow every alias or computed access: for example a value passed through a function, an object property read with a computed key, or code loaded from outside `src/stack-posts`. Code review remains the backstop for deliberate bypasses. The runtime controls in the rest of this decision (exact URL pattern, no redirects, size and time caps) do not depend on the lint rule.
- Before any I/O it accepts only a URL that matches `^https://www\.google\.com/alerts/feeds/[0-9]+/[0-9]+$` and whose `URL` parse has no port, credentials, query or fragment. It then requests `https://www.google.com` + the parsed path, never the raw input.
- `redirect: "manual"`: any 3xx is a failure (`redirected`) and `Location` is never read. 10 s timeout. 1 MiB cap read as a stream. Retries only on 429 and 5xx, with the board readers' delays, and only for scheduled reads.
- Failures are classified into six codes (`not_reachable`, `unexpected_response`, `redirected`, `not_a_feed`, `too_large`, `timed_out`). Registration and scheduled reads share them.
- Feed entry links are parsed, never requested. The LinkedIn target is read from the `url` query parameter.
- `www.google.com` is never added to `BOARD_API_HOSTS`.

## Alternatives rejected

- Add `www.google.com` to the board allowlist: any board reader bug could then reach search pages. AC 6.1 rejects this explicitly.
- Add per-host path prefixes to the shared board client: this widens a client six readers depend on, and a prefix check (`/alerts/feeds/`) is looser than the exact pattern.
- Route through the Squid egress proxy (ADR 0008): it filters by host only and was built for the browser. It adds a hop without adding path control.

## Consequences

- Two small HTTP clients exist instead of one. Their limits are compared by a test ("no looser than the board readers").
- Any future alert source (PRD backlog) needs its own exact pattern and permitted-use check rather than a host entry.
- The lint rule covers the SEC-E5-07 and SEC-E5F-01 gaps (dynamic `import()`, `undici` subpaths, `window.fetch`, `process.getBuiltinModule`, `node_modules` paths, `eval` and `Function`, `child_process`, `worker_threads`, `dns`, `dgram`, `EventSource`, `process.binding`, `globalThis` aliasing and `Reflect`). Aliasing it cannot see stays a review item, as stated above.
- If Google answers automated reads with a consent or "sorry" redirect, feeds show `redirected` and Eve does not work around it.
