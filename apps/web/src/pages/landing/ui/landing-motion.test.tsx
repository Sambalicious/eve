import { act, fireEvent, render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { parallaxOffset } from "../model/hero-fragments"
import { LandingContent } from "./landing-content"

type FakeAnimation = { element: Element; keyframes: Keyframe[]; options: KeyframeAnimationOptions; calls: string[]; resolve: () => void }

/** A world with motion allowed: WAAPI, IntersectionObserver and matchMedia under test control. */
function motionWorld({ reduce = false, fineHover = true, wide = true } = {}) {
  const animations: FakeAnimation[] = []
  const observers: { callback: IntersectionObserverCallback; targets: Element[] }[] = []
  const mediaListeners = new Map<string, Set<() => void>>()
  const media = { reduce, fineHover, wide }

  vi.stubGlobal(
    "IntersectionObserver",
    class {
      targets: Element[] = []
      callback: IntersectionObserverCallback
      constructor(callback: IntersectionObserverCallback) {
        this.callback = callback
        observers.push(this)
      }
      observe(el: Element) {
        this.targets.push(el)
      }
      unobserve(el: Element) {
        this.targets = this.targets.filter((t) => t !== el)
      }
      disconnect() {
        this.targets = []
      }
    }
  )
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
    let resolve!: () => void
    const finished = new Promise<Animation>((ok) => (resolve = () => ok(animation as unknown as Animation)))
    const calls: string[] = []
    const record: FakeAnimation = { element: this, keyframes: keyframes as Keyframe[], options: options as KeyframeAnimationOptions, calls, resolve: () => resolve() }
    const animation = {
      finished,
      pause: () => calls.push("pause"),
      play: () => calls.push("play"),
      cancel: () => calls.push("cancel"),
      finish: () => {
        calls.push("finish")
        resolve()
      },
    }
    animations.push(record)
    return animation as unknown as Animation
  } as typeof Element.prototype.animate
  window.matchMedia = (query: string) =>
    ({
      // Live, like a real MediaQueryList.
      get matches() {
        if (query.includes("reduced-motion: reduce")) return media.reduce
        if (query.includes("hover: hover")) return media.fineHover
        // Fragment visibility queries: wide means a 1280 desktop.
        if (query.includes("min-width: 768px") || query.includes("min-width: 1280px")) return media.wide && (!query.includes("min-height") || true)
        if (query.includes("min-height: 480px")) return true
        return false
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => {
        if (!mediaListeners.has(query)) mediaListeners.set(query, new Set())
        mediaListeners.get(query)!.add(fn)
      },
      removeEventListener: (_: string, fn: () => void) => mediaListeners.get(query)?.delete(fn),
    }) as unknown as MediaQueryList
  if (!reduce) document.documentElement.classList.add("motion-ok")

  const frameObserver = () => observers.find((o) => o.targets.some((t) => t.classList.contains("hf")))!
  const heroObserver = () => observers.find((o) => o.targets.some((t) => t.classList.contains("landing-hero")))!
  return {
    animations,
    media,
    showFrame(ratio = 1) {
      const o = frameObserver()
      act(() =>
        o.callback(
          [{ target: o.targets[0], isIntersecting: ratio > 0, intersectionRatio: ratio, intersectionRect: { height: 400 * ratio }, rootBounds: { height: 800 } } as unknown as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      )
    },
    showHero(visible: boolean) {
      const o = heroObserver()
      act(() =>
        o.callback([{ target: o.targets[0], isIntersecting: visible, intersectionRatio: visible ? 1 : 0 } as unknown as IntersectionObserverEntry], {} as IntersectionObserver)
      )
    },
    setReduce(value: boolean) {
      media.reduce = value
      act(() => mediaListeners.get("(prefers-reduced-motion: reduce)")?.forEach((fn) => fn()))
    },
  }
}

const frame = () => document.querySelector<HTMLElement>(".hf")!
const sceneAnimations = (all: FakeAnimation[]) => all.filter((a) => a.element.hasAttribute("data-a"))
const fragmentAnimations = (all: FakeAnimation[]) => all.filter((a) => a.element.hasAttribute("data-fragment"))
const hero = () => document.querySelector<HTMLElement>(".landing-hero")!

/** Lets the frame's run end: resolve every scene and fragment animation. */
async function finishRun(world: ReturnType<typeof motionWorld>) {
  await act(async () => {
    world.animations.forEach((a) => a.resolve())
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderLanding() {
  render(
    <MemoryRouter>
      <LandingContent path="/" signedIn={false} />
    </MemoryRouter>
  )
  // Two animation frames plus the 300 ms font cap.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(350)
  })
}

describe("hero frame motion (hero-frame.feature, reduced-motion-preferences.feature)", () => {
  const originalAnimate = Element.prototype.animate
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance"] })
  })
  afterEach(() => {
    Element.prototype.animate = originalAnimate
    document.documentElement.classList.remove("motion-ok", "motion-ready")
    vi.unstubAllGlobals()
  })

  it("arms on first paint and starts once the frame is 20% visible (F-QA-E3C-01 ruling)", async () => {
    const world = motionWorld()
    await renderLanding()
    expect(frame().dataset.motion).toBe("armed")
    world.showFrame(0.1)
    expect(sceneAnimations(world.animations)).toHaveLength(0)
    // 1280x800: 36% of the frame is in view at load.
    world.showFrame(0.2)
    expect(frame().dataset.motion).toBe("playing")
    const groups = new Set(sceneAnimations(world.animations).map((a) => a.element.getAttribute("data-a")))
    expect(groups).toEqual(new Set(["posting", "elig-label", "rule", "rule-badge", "match-badge", "match-line", "fact", "arrow", "line-label", "chunk", "status-row", "status-prev", "status-next", "evidence", "mail"]))
  })

  it("observes the 0.2 threshold", async () => {
    motionWorld()
    const thresholds: (number | number[] | undefined)[] = []
    const Base = globalThis.IntersectionObserver
    vi.stubGlobal(
      "IntersectionObserver",
      class extends Base {
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          super(callback, options)
          thresholds.push(options?.threshold)
        }
      }
    )
    await renderLanding()
    expect(thresholds.some((t) => Array.isArray(t) && t.includes(0.2))).toBe(true)
  })

  it("starts after the frame has been in view for 600 ms, even below 20%", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showFrame(0.1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(599)
    })
    expect(sceneAnimations(world.animations)).toHaveLength(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(frame().dataset.motion).toBe("playing")
  })

  it("leaving the viewport resets the 600 ms dwell", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showFrame(0.1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    world.showFrame(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    world.showFrame(0.1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(sceneAnimations(world.animations)).toHaveLength(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250)
    })
    expect(frame().dataset.motion).toBe("playing")
  })

  it("animates only transform and opacity, with backwards fill", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showFrame(1)
    for (const a of sceneAnimations(world.animations)) {
      for (const frame of a.keyframes) for (const key of Object.keys(frame)) expect(["opacity", "transform", "transformOrigin"]).toContain(key)
      expect(a.options.fill).toBe("backwards")
    }
  })

  it("narrow layouts animate three rules, not five", async () => {
    const world = motionWorld({ wide: false })
    await renderLanding()
    world.showFrame(1)
    expect(sceneAnimations(world.animations).filter((a) => a.element.getAttribute("data-a") === "rule")).toHaveLength(3)
  })

  it("plays once, then rests on the end state", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showFrame(1)
    await act(async () => {
      world.animations.forEach((a) => a.resolve())
      await Promise.resolve()
    })
    expect(frame().dataset.motion).toBe("end")
    const count = world.animations.length
    world.showFrame(0)
    world.showFrame(1)
    expect(world.animations).toHaveLength(count)
  })

  it("hover pauses on fine pointers and shows Paused; leaving resumes", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showFrame(1)
    fireEvent.pointerEnter(frame())
    expect(frame().dataset.motion).toBe("paused")
    expect(document.querySelector(".hf-paused")).toHaveAttribute("data-show")
    fireEvent.pointerLeave(frame())
    expect(frame().dataset.motion).toBe("playing")
    expect(document.querySelector(".hf-paused")).not.toHaveAttribute("data-show")
  })

  it("touch does not pause the sequence", async () => {
    const world = motionWorld({ fineHover: false })
    await renderLanding()
    world.showFrame(1)
    fireEvent.pointerEnter(frame())
    expect(frame().dataset.motion).toBe("playing")
  })

  it("window blur pauses without the Paused label, focus resumes", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showFrame(1)
    act(() => void window.dispatchEvent(new Event("blur")))
    expect(frame().dataset.motion).toBe("paused")
    expect(document.querySelector(".hf-paused")).not.toHaveAttribute("data-show")
    act(() => void window.dispatchEvent(new Event("focus")))
    expect(frame().dataset.motion).toBe("playing")
  })

  it("Replay is shown when motion is allowed and fades before rebuilding", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showFrame(1)
    const replay = screen.getByRole("button", { name: "Replay animation" })
    expect(replay).toBeVisible()
    fireEvent.click(replay)
    expect(frame().dataset.motion).toBe("rewinding")
    fireEvent.click(replay)
    const fades = world.animations.filter((a) => a.element.classList.contains("hf-body"))
    expect(fades).toHaveLength(1)
  })

  it("turning reduced motion on mid-run finishes the run, hides Replay and drops motion-ok", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showFrame(1)
    world.setReduce(true)
    expect(frame().dataset.motion).toBe("end")
    for (const a of sceneAnimations(world.animations)) expect(a.calls).toContain("finish")
    expect(document.documentElement).not.toHaveClass("motion-ok")
    expect(document.querySelector('button[aria-label="Replay animation"]')).toHaveAttribute("hidden")
  })

  it("under reduced motion the frame rests at the end, Replay is hidden, and turning it off shows Replay without replaying", async () => {
    const world = motionWorld({ reduce: true })
    await renderLanding()
    world.showFrame(1)
    expect(frame().dataset.motion).toBe("end")
    expect(world.animations).toHaveLength(0)
    expect(document.querySelector('button[aria-label="Replay animation"]')).toHaveAttribute("hidden")
    world.setReduce(false)
    expect(screen.getByRole("button", { name: "Replay animation" })).toBeVisible()
    expect(world.animations).toHaveLength(0)
  })

  it("leaving the page tears down the player", async () => {
    const world = motionWorld()
    const view = render(
      <MemoryRouter>
        <LandingContent path="/" signedIn={false} />
      </MemoryRouter>
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })
    world.showFrame(1)
    view.unmount()
    for (const a of sceneAnimations(world.animations)) expect(a.calls).toContain("cancel")
  })

  it("adds motion-ready for scroll reveals and marks sections in view revealed at once", async () => {
    motionWorld()
    await renderLanding()
    expect(document.documentElement).toHaveClass("motion-ready")
    // jsdom lays everything out at top 0, inside the fold.
    for (const section of document.querySelectorAll("[data-reveal]")) expect(section).toHaveAttribute("data-revealed")
  })

  // ── Hero fragments (illustrations.feature, design-spec r3 I-HERO) ──
  it("plans each fragment's entrance with the frame at its scene time: opacity and an 8 px rise from 0.96 over 320 ms", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showFrame(1)
    const entrances = fragmentAnimations(world.animations).map((a) => [a.element.getAttribute("data-fragment"), a.options.delay, a.options.duration, a.keyframes[0]])
    expect(entrances).toEqual([
      ["1", 900, 320, { opacity: 0, transform: "translateY(8px) scale(0.96)" }],
      ["2", 1380, 320, { opacity: 0, transform: "translateY(8px) scale(0.96)" }],
      ["3", 2800, 320, { opacity: 0, transform: "translateY(8px) scale(0.96)" }],
      ["4", 3260, 320, { opacity: 0, transform: "translateY(8px) scale(0.96)" }],
    ])
    for (const a of fragmentAnimations(world.animations)) expect(a.options.fill).toBe("backwards")
  })

  it("narrow layouts plan only F2 and F4", async () => {
    const world = motionWorld({ wide: false })
    await renderLanding()
    world.showFrame(1)
    expect(fragmentAnimations(world.animations).map((a) => a.element.getAttribute("data-fragment"))).toEqual(["2", "4"])
  })

  it("Replay re-runs the fragment entrances", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showFrame(1)
    await finishRun(world)
    fireEvent.click(screen.getByRole("button", { name: "Replay animation" }))
    const fade = world.animations.find((a) => a.element.classList.contains("hf-body"))!
    await act(async () => {
      fade.resolve()
      await Promise.resolve()
    })
    expect(fragmentAnimations(world.animations)).toHaveLength(8)
  })

  it("drift starts when the run ends, pauses off-screen and on hover, and stops after 60 s in view", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showHero(true)
    world.showFrame(1)
    expect(hero().dataset.drift).toBeUndefined()
    await finishRun(world)
    expect(hero().dataset.drift).toBe("on")
    expect(hero()).toHaveAttribute("data-hero-visible")
    expect(hero()).not.toHaveAttribute("data-drift-paused")

    world.showHero(false)
    expect(hero()).toHaveAttribute("data-drift-paused")
    expect(hero()).not.toHaveAttribute("data-hero-visible")
    // Off-screen time doesn't count toward the 60 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000)
    })
    expect(hero().dataset.drift).toBe("on")
    world.showHero(true)

    fireEvent.pointerEnter(document.querySelector(".hero-demo")!)
    expect(hero()).toHaveAttribute("data-drift-paused")
    fireEvent.pointerLeave(document.querySelector(".hero-demo")!)
    expect(hero()).not.toHaveAttribute("data-drift-paused")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000)
    })
    expect(hero().dataset.drift).toBe("on")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100)
    })
    expect(hero().dataset.drift).toBe("off")
    // Eases to rest over 600 ms.
    const settle = world.animations.filter((a) => a.element.classList.contains("hero-frag-drift"))
    expect(settle.length).toBeGreaterThan(0)
    for (const a of settle) expect(a.options.duration).toBe(600)

    // Coming back into view runs another 60 s.
    world.showHero(false)
    world.showHero(true)
    expect(hero().dataset.drift).toBe("on")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_100)
    })
    expect(hero().dataset.drift).toBe("off")
  })

  it("a hidden tab pauses the drift", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showHero(true)
    world.showFrame(1)
    await finishRun(world)
    const state = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    act(() => void document.dispatchEvent(new Event("visibilitychange")))
    expect(hero()).toHaveAttribute("data-drift-paused")
    state.mockReturnValue("visible")
    act(() => void document.dispatchEvent(new Event("visibilitychange")))
    expect(hero()).not.toHaveAttribute("data-drift-paused")
    state.mockRestore()
  })

  it("under reduced motion no fragment entrance runs and drift never starts", async () => {
    const world = motionWorld({ reduce: true })
    await renderLanding()
    world.showHero(true)
    world.showFrame(1)
    expect(fragmentAnimations(world.animations)).toHaveLength(0)
    expect(hero().dataset.drift).toBeUndefined()
  })

  it("turning reduced motion on while drifting pauses it at once", async () => {
    const world = motionWorld()
    await renderLanding()
    world.showHero(true)
    world.showFrame(1)
    await finishRun(world)
    world.setReduce(true)
    expect(hero()).toHaveAttribute("data-drift-paused")
  })

  it("without scroll timelines, one passive listener writes --hero-scroll on the hero only while it is in view (clamped parallax)", async () => {
    vi.spyOn(CSS, "supports").mockReturnValue(false)
    const world = motionWorld()
    const add = vi.spyOn(window, "addEventListener")
    await renderLanding()
    world.showHero(true)
    const scrollAdds = add.mock.calls.filter(([type]) => type === "scroll")
    expect(scrollAdds).toHaveLength(1)
    expect(scrollAdds[0][2]).toEqual({ passive: true })
    vi.spyOn(hero(), "getBoundingClientRect").mockReturnValue({ top: -150 } as DOMRect)
    act(() => void window.dispatchEvent(new Event("scroll")))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(hero().style.getPropertyValue("--hero-scroll")).toBe("150")
    expect(document.documentElement.style.getPropertyValue("--hero-scroll")).toBe("")
    const remove = vi.spyOn(window, "removeEventListener")
    world.showHero(false)
    expect(remove.mock.calls.some(([type]) => type === "scroll")).toBe(true)
    vi.restoreAllMocks()
  })

  it("parallax offsets differ per fragment and never exceed 24 px", () => {
    for (const scrolled of [0, 100, 200, 400, 800]) {
      const offsets = ([1, 2, 3, 4] as const).map((n) => parallaxOffset(n, scrolled))
      for (const px of offsets) expect(Math.abs(px)).toBeLessThanOrEqual(24)
      if (scrolled > 0) expect(new Set(offsets).size).toBe(4)
    }
    expect(parallaxOffset(4, 800)).toBe(-24)
  })

  it("leaving the page removes the drift state, observers and scroll handling", async () => {
    vi.spyOn(CSS, "supports").mockReturnValue(false)
    const world = motionWorld()
    const remove = vi.spyOn(window, "removeEventListener")
    const view = render(
      <MemoryRouter>
        <LandingContent path="/" signedIn={false} />
      </MemoryRouter>
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(350)
    })
    world.showHero(true)
    world.showFrame(1)
    await finishRun(world)
    const heroEl = hero()
    view.unmount()
    expect(heroEl.dataset.drift).toBeUndefined()
    expect(remove.mock.calls.some(([type]) => type === "scroll")).toBe(true)
    vi.restoreAllMocks()
  })
})
