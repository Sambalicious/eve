/**
 * Motion tokens (design-spec r1 8.4, r2 dialog additions, r3 fragments and toasts). Mirrors the custom
 * properties in `app/styles/index.css`; `tokens.test.ts` keeps them equal.
 */
export const EASE_STANDARD = "cubic-bezier(0.25, 1, 0.5, 1)"
export const EASE_EMPHASIZED = "cubic-bezier(0.23, 1, 0.32, 1)"

export const DURATION = {
  pressIn: 75,
  fast: 150,
  base: 220,
  reveal: 280,
  dialogIn: 200,
  dialogOut: 150,
  fragmentIn: 320,
  toastIn: 200,
  toastOut: 150,
} as const

/** Hero fragments F1 to F4 idle drift (design-spec r3 I-HERO): px and seconds per half cycle. */
export const DRIFT_AMPLITUDE = [6, 5, 4, 8] as const
export const DRIFT_PERIOD = [7, 8.5, 6, 9.5] as const

export const DISTANCE_REVEAL = 12
export const STAGGER_REVEAL = 60
export const STAGGER_HERO = 70

/** The CSS custom property each token maps to, with its value as CSS. */
export const CSS_TOKENS: Record<string, string> = {
  "--ease-standard": EASE_STANDARD,
  "--ease-emphasized": EASE_EMPHASIZED,
  "--duration-press-in": `${DURATION.pressIn}ms`,
  "--duration-fast": `${DURATION.fast}ms`,
  "--duration-base": `${DURATION.base}ms`,
  "--duration-reveal": `${DURATION.reveal}ms`,
  "--duration-dialog-in": `${DURATION.dialogIn}ms`,
  "--duration-dialog-out": `${DURATION.dialogOut}ms`,
  "--duration-fragment-in": `${DURATION.fragmentIn}ms`,
  "--duration-toast-in": `${DURATION.toastIn}ms`,
  "--duration-toast-out": `${DURATION.toastOut}ms`,
  ...Object.fromEntries(DRIFT_AMPLITUDE.map((px, i) => [`--drift-amplitude-${i + 1}`, `${px}px`])),
  ...Object.fromEntries(DRIFT_PERIOD.map((s, i) => [`--drift-period-${i + 1}`, `${s}s`])),
  "--distance-reveal": `${DISTANCE_REVEAL}px`,
  "--stagger-reveal": `${STAGGER_REVEAL}ms`,
  "--stagger-hero": `${STAGGER_HERO}ms`,
}
