import { act, render } from "@testing-library/react"
import { useRef } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { revealThrough } from "./reveal"
import { useSectionReveal } from "./use-section-reveal"

type FakeObserver = { callback: IntersectionObserverCallback; options?: IntersectionObserverInit; targets: Element[] }
let observer: FakeObserver | null = null

function Page() {
  const ref = useRef<HTMLDivElement>(null)
  useSectionReveal(ref)
  return (
    <div ref={ref}>
      <section data-reveal="steps" id="steps" />
      <section data-reveal="stops" id="stops" />
      <section data-reveal="limits" id="limits" />
      <section data-reveal="access" id="access" />
    </div>
  )
}

/** Puts each section at `tops[i]` px from the viewport top. */
function layout(tops: number[]) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const index = ["steps", "stops", "limits", "access"].indexOf(this.id)
    return { top: tops[index] ?? 0 } as DOMRect
  })
}

const revealed = () => [...document.querySelectorAll("[data-reveal]")].map((s) => s.hasAttribute("data-revealed"))

describe("useSectionReveal (scroll-reveals.feature)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "IntersectionObserver",
      function (callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        const fake: FakeObserver = { callback, options, targets: [] }
        observer = fake
        return {
          observe: (el: Element) => void fake.targets.push(el),
          unobserve: (el: Element) => void (fake.targets = fake.targets.filter((t) => t !== el)),
          disconnect: () => void (fake.targets = []),
        }
      }
    )
    window.innerHeight = 800
  })
  afterEach(() => {
    document.documentElement.classList.remove("motion-ok", "motion-ready")
    window.history.replaceState(null, "", "/")
    vi.unstubAllGlobals()
    observer = null
  })

  it("does nothing without motion-ok: no start state, nothing hidden", () => {
    layout([1000, 2000, 3000, 4000])
    render(<Page />)
    expect(document.documentElement).not.toHaveClass("motion-ready")
    expect(observer).toBeNull()
  })

  it("does nothing when IntersectionObserver is missing", () => {
    document.documentElement.classList.add("motion-ok")
    vi.stubGlobal("IntersectionObserver", undefined)
    render(<Page />)
    expect(document.documentElement).not.toHaveClass("motion-ready")
  })

  it("shows sections already in view at once and observes the rest with the spec's options", () => {
    document.documentElement.classList.add("motion-ok")
    layout([500, 1200, 2000, 3000])
    render(<Page />)
    expect(document.documentElement).toHaveClass("motion-ready")
    expect(revealed()).toEqual([true, false, false, false])
    expect(document.querySelector("#steps")).toHaveAttribute("data-reveal-instant")
    expect(observer?.options).toEqual({ threshold: 0.15, rootMargin: "0px 0px -8% 0px" })
    expect(observer?.targets.map((t) => t.id)).toEqual(["stops", "limits", "access"])
  })

  it("reveals once on entry and never hides again", () => {
    document.documentElement.classList.add("motion-ok")
    layout([1000, 2000, 3000, 4000])
    render(<Page />)
    const stops = document.querySelector("#stops")!
    act(() => observer!.callback([{ target: stops, isIntersecting: true } as unknown as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(stops).toHaveAttribute("data-revealed")
    expect(observer!.targets).not.toContain(stops)
    act(() => observer!.callback([{ target: stops, isIntersecting: false } as unknown as IntersectionObserverEntry], {} as IntersectionObserver))
    expect(stops).toHaveAttribute("data-revealed")
  })

  it("a load with the access hash marks access and every section above it revealed", () => {
    document.documentElement.classList.add("motion-ok")
    window.history.replaceState(null, "", "/#access")
    layout([1000, 2000, 3000, 4000])
    render(<Page />)
    expect(revealed()).toEqual([true, true, true, true])
  })

  it("revealThrough marks only the target and the sections above it", () => {
    const { container } = render(
      <div>
        <section data-reveal="a" id="a" />
        <section data-reveal="b" id="b" />
        <section data-reveal="c" id="c" />
      </div>
    )
    revealThrough(container.firstElementChild as HTMLElement, container.querySelector("#b")!)
    expect([...container.querySelectorAll("section")].map((s) => s.hasAttribute("data-revealed"))).toEqual([true, true, false])
  })
})
