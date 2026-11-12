# Eve design system

Eve is a personal job-application assistant. One Candidate uses it, mostly on a laptop, to check what needs them and to keep their facts, answers and sources correct. The surface is an Operate tool: the Candidate should find everything without noticing the design, and the design should feel calm, exact and trustworthy.

This file owns durable visual decisions. It supersedes the "Style decisions" section of `features/active/FEAT-0001-job-application-assistant/design-spec.r4.md` for typography, colour, spacing, elevation and page composition. Flows, copy, states and accessibility in the spec stay authoritative.

## World

Cool mono with one cobalt accent. White ground, cool grey surfaces, near-black ink, hairline rules. Cobalt appears in exactly three places: the primary action, focus, and the active navigation item (a short bar and its icon). Everything else is neutral; status colours appear only when they carry meaning (met, needs you, failed). No warm tints and no serif: the look must not read as a chat assistant's.

Signature move: **the ledger rule.** Pages are composed of open sections separated by a single hairline, like a well-kept ledger. Cards are reserved for objects that stand alone (the sign-in panel). Nothing is boxed twice.

## Type

| Role | Face | Size / leading | Weight | Tracking |
|---|---|---|---|---|
| Page title | Bricolage Grotesque | 30px / 1.15 (36px from md) | 600 | -0.02em |
| Section title | Geist | 15px / 1.4 | 600 | -0.01em |
| Body | Geist | 14px / 1.5 | 400 | 0 |
| Secondary | Geist | 13px / 1.45, muted | 400 | 0 |
| Column header, meta label | Geist | 12.5px, muted | 500 | 0 |
| Codes and IDs | System mono (`ui-monospace`) | 12.5px | 400 | 0 |

Geist and Bricolage Grotesque are self-hosted (`@fontsource-variable`). Dialog and sheet titles, the wordmark and detail-page titles use Bricolage Grotesque; everything else is Geist. Quotes from the resume or a posting are plain Geist with a thin cobalt-tinted rule, never italic. Numbers in tables and dates use tabular figures.

## Colour

Tokens live in `apps/web/src/app/styles/index.css` (OKLCH). Neutrals carry a faint cool cast (hue about 255). Cobalt is `oklch(0.53 0.19 262)` in light and `oklch(0.68 0.16 262)` in dark; white text on cobalt is 5.3:1. Success and destructive use GitHub Primer's success and danger colours. Every `--*-text` shade measures at least 4.5:1 (AA) on every surface it is used on; filled `--success` and `--destructive` carry white text at 4.5:1 or more. Text on a filled success surface is at least 14px and 500 weight. Warning and info are unchanged. Dark mode is a cool blue-black, not pure black.

## Space and rhythm

- 4px base. Page gutter 16px, 24px from lg.
- Page title block, then 32px, then the first section.
- Sections: 28px between sections, with a hairline rule between them. Inside a section: header, 16px, content.
- Rows in lists: 12px vertical padding, hairline between rows, no outer border.
- Reading width: forms and text pages sit in a 760px column; lists and detail pages use up to 1120px.

## Composition rules

1. One primary (filled) button per view. Everything else is outline, ghost or a link.
2. A page is a stack of `Section`s. Use `layout="split"` (title and description on the left, content on the right, from lg) for settings-like pages; `stack` elsewhere.
3. Lists are rows, not cards. Tables have no outer border, a muted 12.5px header and hairline rows.
4. Empty and locked states sit inside their section as a soft muted fill, never a dashed box (dashed only for real drop targets).
5. Status is an icon plus text (design-spec Status vocabulary), shown as a quiet badge.
6. Elevation: none on content. The inset panel has one hairline ring. Popovers and sheets get a soft offset shadow.
7. Radius: 10px controls, 12px panels and fills, full for avatars and pills.
8. Toasts use Sonner through `shared/ui/toast.tsx`. A toast is a popover surface with a tone edge and tone icon, never a filled status colour. Errors that need an action persist until closed. Field errors are never toasts. A dialog that needs feedback renders its own toaster inside the dialog and dismisses its toasts when it closes.

## Persuade surfaces (public marketing pages only)

The landing page and future public marketing pages may use a Persuade layer on top of the Operate system. The app shell, every signed-in page, dialogs and the Privacy page stay Operate. Persuade adds only what is listed here: display type, tinted section grounds, a second accent from the cobalt family, and cobalt-duotone spot illustrations. It never changes components, controls, focus or status colours, and it keeps one filled button per view.

Tokens are defined on `.landing-root`, not `:root`, so nothing leaks into the app: `--persuade-accent` (azure, graphics only, never text or a control), `--persuade-ink` (line 2 of the h1 only), `--persuade-tint` and `--persuade-tint-strong` (section grounds and the Stops icon discs), and the illustration paints `--illo-fill`, `--illo-fill-2`, `--illo-stroke`, `--illo-accent`, `--illo-paper`. On Persuade surfaces cobalt may also appear in illustration strokes, the Stops icon discs and the h1's second line. Display type: h1 Bricolage Grotesque `clamp(40px, 5.2vw + 12px, 76px)`, 650, -0.035em; section h2 `clamp(28px, 2.2vw + 14px, 44px)`, 600, -0.025em. Values: FEAT-0003 design-spec.r3, Style decisions P6.

## Motion

- Press feedback on every button (scale 0.97, 75ms in, 150ms out).
- Ease-out `cubic-bezier(0.25, 1, 0.5, 1)`, 150 to 220ms. No bounce on UI that wasn't flicked.
- Theme change cross-fades 220ms; instant under reduced motion.
- Header border fades in only when content scrolls under it.

## Accessibility floor

WCAG 2.2 AA. Every section is a labelled `region`. Focus rings use `--ring`. Touch targets grow to 40 to 44px on coarse pointers. Honour reduced motion, reduced transparency and more contrast.

## Recorded decisions (supersede design-spec r4)

These were approved by the Candidate on 19 to 20 Oct 2026 and override the lines noted:

- **Product name** is Eve (was Job Assistant).
- **Shell footer removed.** The template footer only repeated the product name. The shell is sidebar, header and inset panel. Supersedes r4 lines 37, 743 and 1436 where they say "footer".
- **Theme transition** is a 220ms crossfade, instant under reduced motion. Supersedes r4 line 852 ("The existing circular theme transition stays as it is").
- **Typography and palette**: Geist and Bricolage Grotesque on cool mono with a cobalt accent, as above (replaced an earlier warm graphite and serif look that read as too close to Claude). Supersedes the "Inter, the neutral shadcn palette" wording in r4 lines 37 and 1436.
- **Status colours** (21 Oct 2026): success and destructive are GitHub Primer's (light #1a7f37 / #1f883d, #d1242f / #cf222e; dark #3fb950 / #238636, #f85149 / #da3633), with `--*-muted` badge grounds. Replaces "5.3:1 or more" with "at least 4.5:1".
- **Toasts** (21 Oct 2026): Sonner app-wide, replacing the Base UI toast (rule 8).
- **Persuade surfaces** (21 Oct 2026): landing-only extension above.
- **Error pages** (404, 500) are restyled and "Go Back Home" is a link; their copy is unchanged. Supersedes "unchanged" for those pages in r4 line 742.
