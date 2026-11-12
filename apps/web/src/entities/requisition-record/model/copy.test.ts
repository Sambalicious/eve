import { describe, expect, it } from "vitest"

import { recordCopy } from "./copy"

describe("C-DATA-1 is retired (copy-deck-12-month-expiry.md, Retired)", () => {
  it("the old string and its key are gone from recordCopy, so it can't reappear", () => {
    expect(JSON.stringify(recordCopy)).not.toContain("Nothing is deleted automatically")
    expect(recordCopy).not.toHaveProperty("retention")
    expect(recordCopy).not.toHaveProperty("retentionHeading")
  })
})
