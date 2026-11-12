import { describe, expect, it } from "vitest"

import { safeErrorSummary } from "./stack-posts-reader.js"

/** CR-E5-03: the internal-error log names the error class and Eve's own frame, never the message or cause. */
describe("safeErrorSummary (CR-E5-03)", () => {
  const URL_DIGITS = "01234567890123456789/9876543210987654321"

  function withStack(error: Error, frames: string[]): Error {
    error.stack = [`${error.name}: ${error.message}`, ...frames].join("\n")
    return error
  }

  it.each([
    [
      "first own frame under src/, skipping node_modules",
      ["    at Parser.x (/repo/node_modules/pg/lib/parser.js:12:3)", "    at StackPostsRepository.recordRead (/repo/apps/api/src/stack-posts/stack-posts.repository.ts:130:7)"],
      "TypeError at stack-posts.repository.ts:130",
    ],
    ["a dist/ frame in the image", ["    at buildPosts (file:///app/dist/stack-posts/stack-post-builder.js:152:11)"], "TypeError at stack-post-builder.js:152"],
    ["no own frame", ["    at node:internal/process/task_queues:95:5"], "TypeError at unknown"],
  ])("%s", (_name, frames, summary) => {
    expect(safeErrorSummary(withStack(new TypeError(`boom https://www.google.com/alerts/feeds/${URL_DIGITS}`), frames))).toBe(summary)
  })

  it("uses the class name, not a protocol `name` such as pg's \"error\"", () => {
    // pg-protocol sets `name` in the constructor, before V8 formats `stack`, so the header carries it.
    class DatabaseError extends Error {}
    const error = new DatabaseError(`value ${URL_DIGITS}`)
    error.name = "error"
    withStack(error, ["    at q (/repo/apps/api/src/stack-posts/stack-posts.repository.ts:9:1)"])
    expect(safeErrorSummary(error)).toBe("DatabaseError at stack-posts.repository.ts:9")
  })

  it.each([["a string", `thrown ${URL_DIGITS}`], ["null", null], ["an object", { message: URL_DIGITS }]])("a non-Error (%s) gives UnknownError", (_name, value) => {
    expect(safeErrorSummary(value)).toBe("UnknownError at unknown")
  })

  it("never contains the message or the cause", () => {
    const error = new Error(`message ${URL_DIGITS}`, { cause: new Error(`cause ${URL_DIGITS}`) })
    expect(safeErrorSummary(error)).not.toContain(URL_DIGITS)
  })

  /**
   * SEC-E5F-03 (architecture r4 item 4): the frame comes only from the lines after V8's
   * `Error.prototype.toString` header. A message or name line shaped like a frame is never used.
   */
  describe("frames come from the stack only (SEC-E5F-03)", () => {
    const PROBE = "    at x (/src/www.google.com.ts:1:1)"

    /** A real error thrown from this spec file (an own `src/` frame), so V8 formats the stack itself. */
    function thrownHere(make: () => Error): Error {
      try {
        throw make()
      } catch (error) {
        return error as Error
      }
    }

    it("a multi-line message whose second line looks like a frame: the real frame", () => {
      const error = thrownHere(() => new Error(`boom\n${PROBE}`))
      const summary = safeErrorSummary(error)
      expect(summary).toMatch(/^Error at stack-posts-reader\.spec\.ts:\d+$/)
      expect(summary).not.toContain("www.google.com.ts")
    })

    it("a multi-line name whose second line looks like a frame: the real frame", () => {
      const error = thrownHere(() => {
        const made = new Error("boom")
        made.name = `Error\n${PROBE}`
        return made
      })
      expect(safeErrorSummary(error)).toMatch(/^Error at stack-posts-reader\.spec\.ts:\d+$/)
    })

    it("a message changed after the stack was read: unknown, never a guess", () => {
      const error = thrownHere(() => new Error("boom"))
      void error.stack
      error.message = `boom\n${PROBE}`
      expect(safeErrorSummary(error)).toBe("Error at unknown")
    })

    it("a stack whose header is not the error's toString (not V8-shaped): unknown", () => {
      const error = new TypeError("boom")
      error.stack = `TypeError: boom extra\n${PROBE}`
      expect(safeErrorSummary(error)).toBe("TypeError at unknown")
    })

    it("a name getter that throws: unknown", () => {
      const error = thrownHere(() => new Error("boom"))
      void error.stack
      Object.defineProperty(error, "name", {
        get() {
          throw new Error("no name")
        },
      })
      expect(safeErrorSummary(error)).toBe("Error at unknown")
    })

    it("a frame-shaped line not indented as a V8 frame is skipped", () => {
      const error = withStack(new TypeError("boom"), ["at x (/repo/apps/api/src/www.google.com.ts:1:1)", "    at y (/repo/apps/api/src/stack-posts/stack-post-builder.ts:7:2)"])
      expect(safeErrorSummary(error)).toBe("TypeError at stack-post-builder.ts:7")
    })
  })
})
