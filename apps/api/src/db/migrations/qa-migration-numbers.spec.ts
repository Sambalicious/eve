import { describe, expect, it } from "vitest"

import { migrationsFor } from "./index.js"

/**
 * QA-owned gap test (EPIC-0002 A1, run epic-0002-a0-a1c, qa-1).
 * migration-and-operator-bootstrap.feature:84 "Two migrations with the same
 * number are refused" and :66 (next free number, no reserved gap, D19/K7).
 */
export function duplicateNumbers(names: readonly string[]): string[] {
  const seen = new Map<string, number>()
  for (const name of names) {
    const number = name.slice(0, 4)
    seen.set(number, (seen.get(number) ?? 0) + 1)
  }
  return [...seen].filter(([, count]) => count > 1).map(([number]) => number)
}

describe("migration numbers", () => {
  const names = Object.keys(migrationsFor({ operatorGoogleSub: undefined }))

  it("no two migrations share a number", () => {
    expect(duplicateNumbers(names)).toEqual([])
  })

  it("the check names a duplicate number", () => {
    expect(duplicateNumbers([...names, "0011-another"])).toEqual(["0011"])
  })

  it("numbers run 0001 to 0041 with no gap and in order", () => {
    expect(names.map((name) => Number(name.slice(0, 4)))).toEqual(Array.from({ length: names.length }, (_, i) => i + 1))
    expect(names.at(-1)).toBe("0041-lead-policy-binding")
  })
})
