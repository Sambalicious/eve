import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SESSION_HINT_KEY } from "@/entities/session"

const html = readFileSync(`${(import.meta as ImportMeta & { dirname: string }).dirname}/../../index.html`, "utf8")
const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]

function runBoot({ path = "/", reduce = false, dark = false, io = true } = {}) {
  window.history.replaceState(null, "", path)
  window.matchMedia = ((query: string) => ({
    matches: query.includes("no-preference") ? !reduce : query.includes("dark") ? dark : false,
  })) as unknown as typeof window.matchMedia
  // The script tests `"IntersectionObserver" in window`, so remove the property itself.
  if (!io) Reflect.deleteProperty(window, "IntersectionObserver")
  else vi.stubGlobal("IntersectionObserver", class {})
  new Function(script)()
}

const classes = () => document.documentElement.classList

describe("index.html boot script (architecture r1 section 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    document.documentElement.className = ""
    Element.prototype.animate ??= (() => ({})) as never
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.documentElement.className = ""
    delete window.__eveReady
    window.history.replaceState(null, "", "/")
  })

  it("reads the same storage keys as ThemeProvider and the session hint", () => {
    expect(script).toContain('"eve-theme"')
    expect(script).toContain('"job-assistant-theme"')
    expect(script).toContain(`"${SESSION_HINT_KEY}"`)
  })

  it("adds motion-ok only without reduced motion and with IO and WAAPI", () => {
    runBoot()
    expect(classes()).toContain("motion-ok")
    document.documentElement.className = ""
    runBoot({ reduce: true })
    expect(classes()).not.toContain("motion-ok")
    document.documentElement.className = ""
    runBoot({ io: false })
    expect(classes()).not.toContain("motion-ok")
  })

  it.each([
    ["/", "1", true],
    ["/about", "1", true],
    ["/", null, false],
    ["/dashboard", "1", false],
  ] as const)("on %s with hint %s, session-pending is %s", (path, hint, expected) => {
    if (hint) localStorage.setItem(SESSION_HINT_KEY, hint)
    runBoot({ path })
    expect(classes().contains("session-pending")).toBe(expected)
  })

  it("applies the stored or system dark theme before paint", () => {
    localStorage.setItem("eve-theme", "dark")
    runBoot()
    expect(classes()).toContain("dark")
    document.documentElement.className = ""
    localStorage.clear()
    runBoot({ dark: true })
    expect(classes()).toContain("dark")
  })

  it("removes motion-ok and session-pending after 3 s if the app never rendered", () => {
    localStorage.setItem(SESSION_HINT_KEY, "1")
    runBoot()
    vi.advanceTimersByTime(3000)
    expect(classes()).not.toContain("motion-ok")
    expect(classes()).not.toContain("session-pending")
  })

  it("keeps the classes after 3 s once the app is ready", () => {
    runBoot()
    window.__eveReady = true
    vi.advanceTimersByTime(3000)
    expect(classes()).toContain("motion-ok")
  })

  it("survives blocked storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError")
    })
    expect(() => runBoot()).not.toThrow()
  })
})
