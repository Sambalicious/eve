# 0003. Feature-Sliced Design in the dashboard, with "components" instead of "widgets"

Date: 2026-10-16
Status: Accepted (Candidate decision)

## Context

The dashboard template organised code by page folders plus a flat `components/` directory, so any file could import any other. The Candidate chose Feature-Sliced Design (FSD) for `apps/web`, and wants the FSD "widgets" layer named "components".

## Decision

`apps/web/src` uses these layers, top to bottom:

| Layer | Holds | Example |
|---|---|---|
| `app` | Entry point, providers, router, global styles | `app/main.tsx`, `app/router/routes.tsx` |
| `pages` | One slice per route | `pages/dashboard` |
| `components` | Composite UI blocks built from features and entities (FSD "widgets") | `components/app-shell` |
| `features` | User actions | `features/toggle-theme` |
| `entities` | Domain objects such as Application or Job Posting | none yet |
| `shared` | Domain-free code: shadcn/ui in `shared/ui`, helpers in `shared/lib` | `shared/ui/button.tsx` |

Rules:

- A layer imports only from layers below it. Slices in one layer don't import each other.
- Other layers import a slice only through its `index.ts`. Files inside a slice import each other directly.
- shadcn/ui is the component library, built on Base UI (`style: "base-nova"`, `@base-ui/react`). `components.json` adds new shadcn components to `shared/ui`, and Radix packages aren't used.
- `eslint-plugin-boundaries` enforces the layer, slice, and `index.ts` rules in `eslint.config.js`. `pnpm lint` fails on a violation.

## Consequences

- In this project, the folder `components/` means the FSD widgets layer, not "all components". shadcn primitives live in `shared/ui`.
- When two components share a part, it moves down a layer or both parts join one slice. `app-shell` holds the sidebar, header, and footer for this reason.
- FSD documentation and tooling that say "widgets" map to `components` here.
