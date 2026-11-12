# 0006. Mastra core with tool-less agents behind a provider-approval gateway

Date: 2026-10-16
Status: Accepted (Candidate decision, 2026-10-16)

Amended 2026-10-18 (Candidate decision, from slice 2 review CR2-05). See "Amendment 2026-10-18" below; it supersedes the credential and error-strategy bullets.

Amended by ADR 0008 (Proposed): one agent, the form agent, has tools. They are backend-written wrappers over Playwright MCP that accept Approved Answer keys only and cannot submit, navigate, or type model-written text. Every other agent stays tool-less.

## Context

ADR 0001 runs Mastra inside a NestJS backend on the Fastify adapter. The official `@mastra/nestjs` module is Express-only and throws at startup on other adapters (https://mastra.ai/reference/server/nestjs-adapter.md). The PRD requires that no career data reaches an AI provider until the Candidate approves one and records its retention and training terms, with a test asserting zero outbound calls. It also requires that job pages and emails cannot change rules, and that caps, spend limits, duplicates, and Eligibility hold whatever the model says.

## Decision

- Use `@mastra/core` agents constructed inside a Nest provider. Do not use `@mastra/nestjs` and do not expose Mastra HTTP routes. Use Mastra structured output with Zod schemas and the `strict` error strategy (https://mastra.ai/docs/agents/structured-output.md).
- Agents have no tools. Untrusted text (job pages, form labels, emails) goes in only as delimited data fields. Every output is a proposal that backend code validates: quotes must be substrings of the source, fact IDs must exist in the approved Career Profile, and form answers must be Approved Answer IDs.
- All model access goes through a `ModelGateway` port. It loads provider credentials, stored encrypted in Postgres, only when an approved-provider record with recorded terms exists, and builds the model client only for that provider. No provider key lives in environment variables. Every call first reserves its estimated cost in the spend ledger.
- Scheduling uses `pg-boss` (ADR 0004), not Mastra's scheduler.

## Alternatives rejected

- `@mastra/nestjs`: incompatible with Fastify, so it would contradict ADR 0001.
- Agents with tools such as browse or fill: injected instructions could steer actions with side effects.
- A provider key in environment variables: the zero-call state would depend on configuration rather than on code.

## Consequences

- The zero-outbound test is straightforward: with no approved provider, the gateway has no client.
- Mastra memory, Studio, and server features go unused in production.
- **Unverified:** whether a Mastra `Agent` accepts a model instance built at runtime from a database credential. An engineering spike must confirm it first. If not, the gateway calls the provider SDK directly behind the same port.

## Amendment 2026-10-18

Candidate decision after the slice 2 code review (CR2-05). The code as built is the rule:

- **Credential location.** The Anthropic API key lives only in the server's environment (`ANTHROPIC_API_KEY`). It is never stored in the database, entered in the dashboard, logged, returned by the API, or passed to the extraction child process. This replaces "stored encrypted in Postgres" and "no provider key lives in environment variables".
- **The gate is still in code.** The gateway builds no client unless an approved-provider record with recorded terms exists, so the zero-outbound guarantee doesn't depend on whether the key is configured. A test counts outbound requests with the key set and approval absent, and expects zero.
- **Host is fixed.** The Anthropic base URL is a code constant (`https://api.anthropic.com/v1`, SEC-202); no environment variable can redirect it.
- **Error strategy.** Structured output uses Mastra's `fallback` strategy with a private sentinel value, not `strict`. A schema failure becomes an invalid-output result that backend code handles, and the model's raw output never reaches logs (the `strict` error carries it in `details.value`).
- **Spend.** Each call's token usage is recorded in `ai_call`. Reserving estimated cost before each call, and the monthly ceiling, belong to the cost-ceiling slice.

Rejected alternative: entering the key in the dashboard with encrypted database storage. It adds a key-management surface, and a database compromise would expose the key alongside career data.
