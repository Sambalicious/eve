import { EASE_EMPHASIZED, EASE_STANDARD } from "./tokens"

/** Only these properties may animate (AC 3.7). */
export type MotionFrame = { opacity?: number; transform?: string }

/** One row of a timeline table: a target group, when it starts, and how it moves. */
export interface Step {
  /** The `data-a` name of the element group. */
  target: string
  start: number
  duration: number
  easing: string
  from: MotionFrame
  to: MotionFrame
  /** Delay between successive elements of the group. */
  stagger?: number
  origin?: string
}

export interface ResolvedAnimation {
  target: string
  /** Position of the element within its group. */
  index: number
  delay: number
  duration: number
  easing: string
  fill: "backwards"
  keyframes: Keyframe[]
}

/** Expands groups into one animation per element, using `counts[target]` elements each. */
export function resolveTimeline(steps: readonly Step[], counts: Readonly<Record<string, number>>): ResolvedAnimation[] {
  return steps.flatMap((step) =>
    Array.from({ length: counts[step.target] ?? 0 }, (_, index) => ({
      target: step.target,
      index,
      delay: step.start + index * (step.stagger ?? 0),
      duration: step.duration,
      easing: step.easing,
      fill: "backwards" as const,
      keyframes: [withOrigin(step.from, step.origin), withOrigin(step.to, step.origin)],
    }))
  )
}

export function totalDuration(animations: readonly ResolvedAnimation[]): number {
  return animations.reduce((end, a) => Math.max(end, a.delay + a.duration), 0)
}

const ALLOWED_KEYS = new Set(["opacity", "transform"])
const EASINGS = new Set([EASE_STANDARD, EASE_EMPHASIZED])
const MIN_SCALE = 0.9
const MAX_TOTAL_MS = 5000

/**
 * Lists the ways a timeline breaks the motion rules (AC 3.7, 3.8, 3.10, 3.4):
 * only opacity and transform, 150 to 400 ms per element, 30 to 80 ms
 * staggers, no scale below 0.9, the two token curves, 5 s at most.
 */
export function validateTimeline(steps: readonly Step[], counts: Readonly<Record<string, number>>): string[] {
  const errors: string[] = []
  for (const step of steps) {
    for (const key of [...Object.keys(step.from), ...Object.keys(step.to)]) {
      if (!ALLOWED_KEYS.has(key)) errors.push(`${step.target}: animates ${key}`)
    }
    if (step.duration < 150 || step.duration > 400) errors.push(`${step.target}: ${step.duration} ms is outside 150 to 400 ms`)
    if (step.stagger !== undefined && (step.stagger < 30 || step.stagger > 80)) {
      errors.push(`${step.target}: stagger ${step.stagger} ms is outside 30 to 80 ms`)
    }
    if (!EASINGS.has(step.easing)) errors.push(`${step.target}: easing ${step.easing} is not a token curve`)
    for (const frame of [step.from, step.to]) {
      const scale = /scale\(([\d.]+)\)/.exec(frame.transform ?? "")
      if (scale && Number(scale[1]) < MIN_SCALE) errors.push(`${step.target}: scale ${scale[1]} is below ${MIN_SCALE}`)
    }
  }
  const total = totalDuration(resolveTimeline(steps, counts))
  if (total > MAX_TOTAL_MS) errors.push(`total ${total} ms is over ${MAX_TOTAL_MS} ms`)
  return errors
}

function withOrigin(frame: MotionFrame, origin: string | undefined): Keyframe {
  return origin ? { ...frame, transformOrigin: origin } : { ...frame }
}
