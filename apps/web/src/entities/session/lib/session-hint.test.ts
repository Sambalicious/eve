import { afterEach, describe, expect, it, vi } from "vitest"

import { clearSessionHint, markSignedIn, readSessionHint, SESSION_HINT_KEY } from "./session-hint"

describe("session hint", () => {
  afterEach(() => vi.restoreAllMocks())

  it("is off until a session is confirmed", () => {
    expect(readSessionHint()).toBe(false)
  })

  it("is on after a confirmed session and off again once cleared", () => {
    markSignedIn()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBe("1")
    expect(readSessionHint()).toBe(true)
    clearSessionHint()
    expect(localStorage.getItem(SESSION_HINT_KEY)).toBeNull()
    expect(readSessionHint()).toBe(false)
  })

  it("treats any other stored value as off", () => {
    localStorage.setItem(SESSION_HINT_KEY, "true")
    expect(readSessionHint()).toBe(false)
  })

  it("never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError")
    })
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError")
    })
    expect(readSessionHint()).toBe(false)
    expect(() => markSignedIn()).not.toThrow()
    expect(() => clearSessionHint()).not.toThrow()
  })
})
