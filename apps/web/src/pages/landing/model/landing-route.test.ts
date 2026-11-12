import { describe, expect, it } from "vitest"

import { decideLanding, SESSION_HOLD_MS } from "./landing-route"

describe("decideLanding (architecture r0 section 1 table)", () => {
  it.each([
    // path, hint, session, held ms, result
    ["/", false, "success", 0, "redirect"],
    ["/", true, "success", 0, "redirect"],
    ["/", true, "pending", 0, "hold"],
    ["/", true, "pending", SESSION_HOLD_MS - 1, "hold"],
    ["/", true, "pending", SESSION_HOLD_MS, "show"],
    ["/", false, "pending", 0, "show"],
    ["/", false, "error", 0, "show"],
    ["/", true, "error", 0, "show"],
    ["/about", true, "pending", 0, "hold"],
    ["/about", true, "pending", SESSION_HOLD_MS, "show"],
    ["/about", false, "pending", 0, "show"],
    ["/about", true, "success", 0, "show"],
    ["/about", false, "error", 0, "show"],
  ] as const)("%s hint=%s session=%s after %i ms: %s", (path, hint, session, heldMs, result) => {
    expect(decideLanding({ path, hint, session, heldMs })).toBe(result)
  })

  it("holds for at most two seconds", () => {
    expect(SESSION_HOLD_MS).toBe(2000)
  })
})
