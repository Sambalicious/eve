import { DURATION, EASE_STANDARD } from "./tokens"

export type PauseReason = "hover" | "blur" | "hidden" | "offscreen"
export type MotionState = "end" | "armed" | "playing" | "paused" | "rewinding"

export type AnimateFn = (element: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) => Animation

export interface PlannedAnimation {
  element: Element
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
}

interface PlayerOptions {
  /** The frame; its `data-motion` attribute carries the state for CSS. */
  root: HTMLElement
  /** Builds the scene animations for the current layout, called on every run. */
  plan: () => PlannedAnimation[]
  /** The layer Replay fades out before rebuilding. */
  bodySelector?: string
  animate?: AnimateFn
  onChange?: (state: { motion: MotionState; hoverOnly: boolean }) => void
}

export interface Player {
  play(): void
  replay(): void
  pause(reason: PauseReason): void
  resume(reason: PauseReason): void
  finish(): void
  destroy(): void
}

const defaultAnimate: AnimateFn = (element, keyframes, options) => element.animate(keyframes, options)

/**
 * The hero frame's state machine (design-spec r1 4.6) over WAAPI. No React:
 * it touches DOM nodes directly so no animation value goes through a render.
 * One run id guards every callback, so runs never stack.
 */
export function createPlayer({ root, plan, bodySelector = ".hf-body", animate = defaultAnimate, onChange }: PlayerOptions): Player {
  let run = 0
  let animations: Animation[] = []
  let fade: Animation | null = null
  let motion: MotionState = (root.dataset.motion as MotionState | undefined) ?? "end"
  const reasons = new Set<PauseReason>()

  const set = (next: MotionState) => {
    motion = next
    root.dataset.motion = next
    onChange?.({ motion, hoverOnly: reasons.size === 1 && reasons.has("hover") })
  }

  const start = () => {
    const id = ++run
    animations = plan().map(({ element, keyframes, options }) => animate(element, keyframes, options))
    set(reasons.size > 0 ? "paused" : "playing")
    if (reasons.size > 0) animations.forEach((a) => a.pause())
    void Promise.all(animations.map((a) => a.finished)).then(
      () => {
        if (id !== run) return
        animations = []
        set("end")
      },
      () => undefined
    )
  }

  const cancelAll = () => {
    for (const a of animations) a.cancel()
    animations = []
    for (const a of root.getAnimations?.({ subtree: true }) ?? []) a.cancel()
  }

  return {
    play: start,

    replay() {
      if (motion === "rewinding") return
      const id = ++run
      reasons.delete("hover")
      const body = root.querySelector(bodySelector)
      if (!body) {
        cancelAll()
        start()
        return
      }
      const from = Number(getComputedStyle(body).opacity) || 1
      set("rewinding")
      const current = animate(body, [{ opacity: from }, { opacity: 0 }], { duration: DURATION.fast, easing: EASE_STANDARD, fill: "forwards" })
      fade = current
      current.finished.then(
        () => {
          if (id !== run) return
          // One synchronous block: the backwards fill shows the start state in the
          // same frame the body returns, so the end state never flashes.
          cancelAll()
          current.cancel()
          fade = null
          start()
        },
        () => undefined
      )
    },

    pause(reason) {
      reasons.add(reason)
      if (motion === "playing" || motion === "paused") {
        animations.forEach((a) => a.pause())
        set("paused")
      } else {
        onChange?.({ motion, hoverOnly: reasons.size === 1 && reasons.has("hover") })
      }
    },

    resume(reason) {
      reasons.delete(reason)
      if (motion === "paused" && reasons.size === 0) {
        animations.forEach((a) => a.play())
        set("playing")
      } else {
        onChange?.({ motion, hoverOnly: reasons.size === 1 && reasons.has("hover") })
      }
    },

    finish() {
      run++
      fade?.cancel()
      fade = null
      for (const a of animations) a.finish()
      animations = []
      set("end")
    },

    destroy() {
      run++
      fade?.cancel()
      fade = null
      cancelAll()
    },
  }
}
