import { describe, expect, it, vi } from "vitest"

import { swallowAndLog } from "./swallow-and-log.js"

describe("swallowAndLog", () => {
  it("returns undefined and warns once with the label and the error's class", () => {
    const warn = vi.fn()

    const handler = swallowAndLog({ warn }, "ledger release")

    expect(handler(new TypeError("the database went away"))).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("ledger release failed: TypeError")
  })

  it("names anything that is not an Error as non-error", () => {
    const warn = vi.fn()

    swallowAndLog({ warn }, "session.close")("a string, a null, a plain object")

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith("session.close failed: non-error")
  })

  it("logs no message, stack or other property of the error", () => {
    const warn = vi.fn()
    const error = new Error("select token from sessions where token = 'SENTINEL_MESSAGE'")
    error.stack = "Error: SENTINEL_STACK"
    Object.assign(error, {
      sql: "SENTINEL_SQL",
      parameters: ["SENTINEL_PARAMETER"],
      email: "SENTINEL_PII@example.com",
      authorization: "SENTINEL_TOKEN",
    })

    swallowAndLog({ warn }, "recordEmail")(error)

    expect(warn).toHaveBeenCalledTimes(1)
    const logged = JSON.stringify(warn.mock.calls)
    expect(logged).toContain("recordEmail failed: Error")
    for (const sentinel of ["SENTINEL_MESSAGE", "SENTINEL_STACK", "SENTINEL_SQL", "SENTINEL_PARAMETER", "SENTINEL_PII", "SENTINEL_TOKEN"]) {
      expect(logged).not.toContain(sentinel)
    }
  })
})
