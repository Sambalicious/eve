import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createToastPlacement,
  decideToastPosition,
  measureContentBand,
  TRIGGER_MAX_AGE_MS,
  type ContentBand,
} from "./toast-placement"

/** EPIC-F2 design-spec.r1.md, "Behaviour below 768px", rules 1 to 4. */

// 375x812: header bottom 56, no bottom inset. mid = (56 + 812) / 2 = 434.
const BAND_812: ContentBand = { top: 56, bottom: 812 }
const NOW = 1_000_000

function trigger(centerY: number, ageMs = 0, connected = true) {
  return { centerY, activatedAt: NOW - ageMs, connected }
}

describe("decideToastPosition", () => {
  it("is always top at 768px and up (the toaster is top right there), whatever the trigger", () => {
    for (const t of [null, trigger(100), trigger(700)]) {
      expect(decideToastPosition({ isMobile: false, trigger: t, now: NOW, band: BAND_812 })).toBe("top")
    }
  })

  it("goes top when the trigger centre is in the lower half", () => {
    expect(decideToastPosition({ isMobile: true, trigger: trigger(796), now: NOW, band: BAND_812 })).toBe("top")
  })

  it("goes top when the trigger centre is exactly at mid", () => {
    expect(decideToastPosition({ isMobile: true, trigger: trigger(434), now: NOW, band: BAND_812 })).toBe("top")
  })

  it("goes bottom when the trigger centre is in the upper half", () => {
    expect(decideToastPosition({ isMobile: true, trigger: trigger(433.5), now: NOW, band: BAND_812 })).toBe("bottom")
    expect(decideToastPosition({ isMobile: true, trigger: trigger(88), now: NOW, band: BAND_812 })).toBe("bottom")
  })

  it("defaults to top with no trigger", () => {
    expect(decideToastPosition({ isMobile: true, trigger: null, now: NOW, band: BAND_812 })).toBe("top")
  })

  it("uses a trigger activated exactly 10 s ago, and ignores an older one", () => {
    expect(TRIGGER_MAX_AGE_MS).toBe(10_000)
    expect(decideToastPosition({ isMobile: true, trigger: trigger(88, 10_000), now: NOW, band: BAND_812 })).toBe("bottom")
    expect(decideToastPosition({ isMobile: true, trigger: trigger(88, 10_001), now: NOW, band: BAND_812 })).toBe("top")
  })

  it("defaults to top when the trigger is no longer in the document", () => {
    expect(decideToastPosition({ isMobile: true, trigger: trigger(88, 0, false), now: NOW, band: BAND_812 })).toBe("top")
  })

  it("splits the content area, not the screen: header and bottom inset move mid", () => {
    // Notched phone: header bottom 56 + 47 = 103, home indicator 34. mid = (103 + 778) / 2 = 440.5.
    const notched = { top: 103, bottom: 778 }
    expect(decideToastPosition({ isMobile: true, trigger: trigger(438), now: NOW, band: notched })).toBe("bottom")
    expect(decideToastPosition({ isMobile: true, trigger: trigger(441), now: NOW, band: notched })).toBe("top")
  })
})

describe("measureContentBand", () => {
  afterEach(() => vi.restoreAllMocks())

  it("falls back to a 56px header and no bottom inset when styles do not resolve (no layout)", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(812)
    expect(measureContentBand(document, window)).toEqual({ top: 56, bottom: 812 })
  })

  it("uses the resolved probe insets and the visual viewport height", () => {
    const fakeWindow = {
      getComputedStyle: () => ({ top: "103px", bottom: "34px" }),
      innerHeight: 812,
      visualViewport: { height: 500 },
    } as unknown as Window
    expect(measureContentBand(document, fakeWindow)).toEqual({ top: 103, bottom: 466 })
  })

  it("removes its probe element", () => {
    measureContentBand(document, window)
    expect(document.body.children).toHaveLength(0)
  })
})

describe("createToastPlacement", () => {
  afterEach(() => {
    document.body.innerHTML = ""
    vi.restoreAllMocks()
  })

  function setup(isMobile = true) {
    document.body.innerHTML = `
      <form><input aria-label="Field" /><button type="submit" id="save">Save changes</button></form>
      <button type="button" id="plain">Add</button>
      <p id="text">Text</p>
      <div data-slot="toast-viewport"><button type="button" id="close">Close toast</button></div>`
    let now = NOW
    const onSubmitPress = vi.fn()
    const placement = createToastPlacement({
      doc: document,
      now: () => now,
      measureBand: () => BAND_812,
    })
    const uninstall = placement.install(onSubmitPress)
    const el = (id: string) => document.getElementById(id) as HTMLElement
    const at = (id: string, centerY: number) => {
      el(id).getBoundingClientRect = () => ({ top: centerY - 16, bottom: centerY + 16, height: 32 }) as DOMRect
    }
    return { placement, uninstall, el, at, onSubmitPress, isMobile, tick: (ms: number) => (now += ms) }
  }

  it("places a toast opposite the last pressed control", () => {
    const { placement, el, at } = setup()
    at("save", 796)
    el("save").click()
    expect(placement.positionFor("t1", true)).toBe("top")
    at("plain", 88)
    el("plain").click()
    expect(placement.positionFor("t2", true)).toBe("bottom")
  })

  it("records the control when a click lands on its child", () => {
    const { placement, el, at } = setup()
    el("plain").innerHTML = "<span id='label'>Add</span>"
    at("plain", 88)
    el("label").click()
    expect(placement.positionFor("t1", true)).toBe("bottom")
  })

  it("decides once per toast: a later trigger or layout change does not move it", () => {
    const { placement, el, at } = setup()
    at("save", 796)
    el("save").click()
    expect(placement.positionFor("t1", true)).toBe("top")
    at("save", 88)
    el("save").click()
    expect(placement.positionFor("t1", true)).toBe("top")
    expect(placement.positionFor("t2", true)).toBe("bottom")
  })

  it("defaults to top when the last press is older than 10 s", () => {
    const { placement, el, at, tick } = setup()
    at("plain", 88)
    el("plain").click()
    tick(10_001)
    expect(placement.positionFor("t1", true)).toBe("top")
  })

  it("defaults to top when no control was pressed", () => {
    const { placement, el } = setup()
    el("text").click()
    expect(placement.positionFor("t1", true)).toBe("top")
  })

  it("ignores presses inside the toast viewport", () => {
    const { placement, el, at } = setup()
    at("plain", 88)
    el("plain").click()
    at("close", 796)
    el("close").click()
    expect(placement.positionFor("t1", true)).toBe("bottom")
  })

  it("is top at 768px and up and does not cache that answer for mobile", () => {
    const { placement, el, at } = setup()
    at("save", 796)
    el("save").click()
    expect(placement.positionFor("t1", false)).toBe("top")
    expect(placement.positionFor("t1", true)).toBe("top")
  })

  it("reports submit-button presses, before the form submits, and nothing else", () => {
    const { el, onSubmitPress } = setup()
    const order: string[] = []
    onSubmitPress.mockImplementation(() => order.push("closed"))
    el("save").closest("form")!.addEventListener("submit", (e) => {
      e.preventDefault()
      order.push("submitted")
    })
    el("plain").click()
    el("close").click()
    expect(onSubmitPress).not.toHaveBeenCalled()
    el("save").click()
    expect(order).toEqual(["closed", "submitted"])
  })

  it("forgets toasts that are gone", () => {
    const { placement, el, at } = setup()
    at("save", 796)
    el("save").click()
    placement.positionFor("t1", true)
    placement.retain([])
    at("save", 88)
    el("save").click()
    expect(placement.positionFor("t1", true)).toBe("bottom")
  })

  it("stops listening after uninstall", () => {
    const { placement, uninstall, el, at, onSubmitPress } = setup()
    uninstall()
    at("plain", 88)
    el("plain").click()
    el("save").click()
    expect(onSubmitPress).not.toHaveBeenCalled()
    expect(placement.positionFor("t1", true)).toBe("top")
  })
})
