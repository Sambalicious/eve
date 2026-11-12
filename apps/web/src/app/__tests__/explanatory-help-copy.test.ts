import { describe, expect, it } from "vitest"

import { jobSourceCopy } from "@/entities/job-source"
import { hiringCopy } from "@/entities/stack-post"

/** Every string in a nested copy object. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === "object") return Object.values(value).flatMap(strings)
  return []
}

/** The EPIC-0009 strings: C-EH-VERIFY-*, C-EH-SRC-*, revised C-SRC-3 and C-EH-HIRING-*. */
const epic0009 = [
  jobSourceCopy.verifyDialog.description,
  jobSourceCopy.verifyDialog.basisHelp,
  ...strings(jobSourceCopy.verifyDialog.why),
  jobSourceCopy.remoteBoardsHelp,
  ...strings(jobSourceCopy.remoteBoardsWhy),
  jobSourceCopy.enableRefused,
  hiringCopy.helpLine,
  ...strings(hiringCopy.helpWhy),
]

describe("EPIC-0009 help copy (help-accessibility-and-invariants.feature @ac-19)", () => {
  it("covers all 29 deck strings plus the revised C-SRC-3", () => {
    // 11 S1 + 6 S2 + 11 S3 slots, C-SRC-3; C-EH-POPOVER-CLOSE lives in shared/ui/help-popover.tsx.
    expect(epic0009).toHaveLength(29)
  })

  it.each(["is permitted", "are permitted", "Eve checked", "Eve verified", "we checked", "this is legal advice"])(
    "no string contains %j",
    (phrase) => {
      expect(epic0009.filter((s) => s.toLowerCase().includes(phrase.toLowerCase()))).toEqual([])
    }
  )

  it("no S1 or S2 string says who can see the basis", () => {
    const jobSource = epic0009.slice(0, 18)
    expect(jobSource.filter((s) => /only you|yours|your boards|shared|anyone/i.test(s))).toEqual([])
  })

  it("C-SRC-3 is the revised text", () => {
    expect(jobSourceCopy.enableRefused).toBe("Verify this board before you enable it. Eve reads only verified boards.")
  })
})
