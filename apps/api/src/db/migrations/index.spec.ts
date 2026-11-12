import { describe, expect, it } from "vitest"

import { migrations } from "./index.js"

/** Architecture "Renumbering risk": keys have unique, strictly increasing four-digit prefixes (Kysely refuses unordered names). */
describe("migration names", () => {
  it("have strictly increasing, unique four-digit prefixes and end with 0041-lead-policy-binding", () => {
    const keys = Object.keys(migrations)
    const prefixes = keys.map((key) => {
      const match = /^(\d{4})-[a-z0-9-]+$/.exec(key)
      if (!match) throw new Error(`bad migration name ${key}`)
      return Number(match[1])
    })
    for (let i = 1; i < prefixes.length; i++) expect(prefixes[i]).toBeGreaterThan(prefixes[i - 1]!)
    expect([...keys].sort()).toEqual(keys)
    expect(keys.at(-1)).toBe("0041-lead-policy-binding")
  })
})
