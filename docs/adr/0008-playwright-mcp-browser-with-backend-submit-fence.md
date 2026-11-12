# 0008. Drive hosted forms through Playwright MCP, with a backend-only submit fence

Date: 2026-10-16
Status: Accepted (Candidate decision, 2026-10-16)

Amends: ADR 0005 (who performs the browser work and the final click) and the "agents have no tools" bullet of ADR 0006 (one agent now has tools). Both stay Proposed and otherwise in force. Supersedes the r0 choice of hand-written Playwright scripts in `epics/active/EPIC-0001-job-application-assistant/architecture.md`.

## Context

The Candidate asked that browser navigation and form handling on Greenhouse, Lever, and Ashby hosted forms run through the Playwright MCP server (https://github.com/microsoft/playwright-mcp), driven by a Mastra agent through `@mastra/mcp` `MCPClient` (https://mastra.ai/reference/tools/mcp-client.md), instead of hand-written Playwright scripts.

Facts that shape the decision, from the Playwright MCP README:

- Playwright MCP "is **not** a security boundary". `--allowed-origins` and `--blocked-origins` do "not serve as a security boundary" and do "not affect redirects".
- There is no flag to allow individual tools. Optional groups are added with `--caps`. The always-on core tools include `browser_navigate`, `browser_click`, `browser_press_key`, `browser_type` (with a `submit` option), `browser_evaluate`, and `browser_run_code_unsafe`, described as "RCE-equivalent".
- By default every action reply carries a full accessibility snapshot. `--snapshot-mode none` turns that off.
- `--isolated` keeps the browser profile in memory. The Docker image supports headless Chromium only and can run as a long-lived service over HTTP on port 8931.

From the Mastra docs: `MCPClient.listTools()` returns every server tool, MCP tool results are untrusted model input, and `forwardInstructions` (off by default) would inject server text into the system prompt.

A local read-only measurement of three live forms gave accessibility snapshots of about 3.6k, 5.6k, and 52k tokens. Two of them loaded reCAPTCHA.

The PRD invariants hold whatever drives the browser. Backend code, not the model, decides Eligibility, caps, duplicates, Approved Answers, and whether to submit. Never submit twice. Record `submitting` before the click. No blind retry. Uncertain Submission exists. No anti-bot bypass. CAPTCHA, login, verification, and assessment produce a Blocked Application. Untrusted page content cannot change rules or pull out personal data. AI provider gate. USD 50 monthly ceiling.

## Decision

- **Server.** Run Playwright MCP, pinned by npm version and image digest, as a long-lived `browser` container over Streamable HTTP with: `--headless --browser chromium --isolated --snapshot-mode none --no-webmcp --block-service-workers --image-responses omit --codegen none --allowed-hosts browser:8931 --proxy-server http://egress:3128 --init-script /guard/submit-guard.js`, short action and navigation timeouts, and no `--caps`, `--user-data-dir`, `--storage-state`, `--extension`, `--cdp-endpoint`, or `--shared-browser-context`.
- **Network.** `browser` shares a Docker network only with `worker` and an `egress` Squid proxy. The proxy denies every host except a per-attempt allowlist: the posting's application host plus a reviewed list of hosts that Application System's form needs, reCAPTCHA hosts included. Backend code checks the top-level origin after every MCP call and aborts on any other origin.
- **Client.** The worker opens one `MCPClient` per attempt with a unique `id`, `allowedHosts: ['browser:8931']`, `forwardInstructions: false`, and `onToolError: 'throw'`, and disconnects at the end. Only backend code holds this client.
- **Backend does the irreversible and the trusted work without a model.** It navigates, reads the form with fixed read-only scripts, writes full snapshots to files rather than prompts, detects blocks, classifies fields, assigns Approved Answer keys, and fills every field it can classify (deterministic-first).
- **The form agent fills leftover fields only, through wrappers.** It never receives Playwright MCP tools. Its tool set is exactly `get_form_digest`, `search_options`, `fill_fields`, `set_choice`, `attach_document`, `report_blocker`, and `finish`, and a test asserts that. Wrappers accept field refs and Approved Answer keys, check them against the backend's answer map and code-assigned categories, check the target element is a fillable control and not a button, link, or submit control, and then make the MCP call with backend values and `submit: false`. No wrapper can click a button or link, press a key, navigate, run script, or type model-written text. The agent never sees personal values or filled values. It runs on the approved provider's cheapest model behind `ModelGateway`.
- **Budgets.** Per attempt: at most 10 agent steps, 80k input and 6k output tokens, 180 s, and USD 0.03. Per month: USD 5 of form-agent spend. Each step reserves its cost in the ledger before the provider call, through a `prepareStep` hook that also prunes history to the latest digest.
- **Submit fence.**
  1. An init script on every page cancels any form `submit` event and any click on a submit-type control, and records the attempt, until the backend opens a one-shot gate.
  2. After the agent finishes, backend code re-reads every control's value and checks that every required field is filled, that every filled value is exactly the backend value assigned to that field, that file inputs hold the expected documents, that the origin is unchanged, that no submit attempt was caught, and that exactly one submit control exists in the form.
  3. It stores a pre-submit snapshot and screenshot as evidence and commits `submitting`.
  4. It opens the one-shot gate and calls `browser_click` on the located submit control once, with no loop and no retry.
  5. It waits for confirmation text, stores post-submit evidence, and parses it in code into `confirmed` or `uncertain`.
- **No anti-bot evasion.** Default user agent, no stealth plugins, no fingerprint changes, no proxy rotation, reCAPTCHA hosts reachable. A visible challenge before the click is a Blocked Application. One that appears only after the click leaves an Uncertain Submission.
- **Failures before the click never submit.** A missing required value gives `blocked` with "missing Approved Answer". Every other pre-click failure (budget exhausted, off-origin redirect, caught submit attempt, value the backend did not write) blocks with a reason the product-manager still has to name (OQ-A1).
- The states, the claim transaction, boot-time recovery to `uncertain`, and retries-off from ADR 0005 are unchanged.

## Alternatives rejected

- **Give the agent the Playwright MCP tools from `listTools()`, filtered by name.** Even a short list keeps `browser_click`, which can hit the submit button, and `browser_type`, which can type model-written text or press Enter. Approval hooks would need a human or would rebuild the wrappers as filters. Writing the wrappers is simpler to test.
- **Let the agent click submit after a backend check.** The click would be gated by the model calling the right tool at the right time. The PRD wants backend code to decide. The backend clicking after verification is no harder to build.
- **Rely on `--allowed-origins` for host restriction.** The README says it is not a security boundary and ignores redirects.
- **Default `--snapshot-mode full` with whole snapshots in context.** About USD 25 or more a month on a cheap model and many times the ceiling on a mid-tier model. One Lever form overflows a model context.
- **Persistent browser profile or saved storage state.** It would carry cookies and logins between employers, and logins are out of scope.
- **Playwright CLI instead of MCP.** Microsoft calls it more token-efficient, but the Candidate asked for MCP, and `--snapshot-mode none` plus the digest recovers most of the difference.
- **Stdio subprocess of the worker.** A Chromium crash or leak would hit the worker, and the browser could not sit on its own network.

## Consequences

- The model can at worst choose a wrong but approved answer key on a free-question field. It cannot submit, navigate, type free text, see personal values, or spend past its caps.
- Typical monthly cost is about USD 28 to 29 on cheap-tier models and USD 24 hosting. The caps allow at most about USD 34. A mid-tier model breaks the ceiling through base AI work alone.
- Two more containers. 4 GB RAM becomes the minimum.
- Evidence snapshots and screenshots contain the Candidate's filled personal data and fall under the 12-month retention and 30-day backup rules.
- Playwright MCP is pre-1.0. Upgrades are deliberate and need wrapper contract tests on saved fixture pages first.
- Fill verification catches agent mistakes, not a hostile page, which controls its own DOM. The egress allowlist limits what such a page could do with what it sees.
- **Unverified**, to settle in engineering spike S-1: per-HTTP-client browser context isolation without `--shared-browser-context`; executing `listTools()` tools from backend code outside an agent (fallback: `@modelcontextprotocol/sdk` `Client`); whether `MCPClient` can resend an in-flight call on reconnect; the MCP protocol revision of `@playwright/mcp` 0.0.83; whether `browser_fill_form` can submit; sandboxed Chromium in the official image; Chromium memory per page; the egress host list and upload method per Application System.
