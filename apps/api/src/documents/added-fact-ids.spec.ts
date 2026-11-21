import { describe, expect, it } from "vitest"

import { addedRowId, isAddedId, isOneLinerId, isSkillOnlyId, oneLinerId, skillOnlyId } from "./added-fact-ids.js"

/**
 * FEAT-0017 SEC-R05: the id namespace's exact-prefix rule (security review
 * Appendix probe 3, TM-01/02). The kind is read from the prefix, so a
 * case-spoofed or shape-spoofed id must not pass as a skill-only one.
 */
describe("FEAT-0017 added-fact ids", () => {
  const rowId = "6f1c0e8a-1111-4a6b-9a01-000000000001"

  it("only the exact lowercase prefix is a skill-only id", () => {
    expect(isSkillOnlyId(skillOnlyId(rowId))).toBe(true)
    expect(isSkillOnlyId(`ADDED:S:${rowId}`)).toBe(false)
    expect(isSkillOnlyId("added:s")).toBe(false)
    expect(isSkillOnlyId(`added:s${rowId}`)).toBe(false)
    expect(isSkillOnlyId(rowId)).toBe(false)
    expect(isSkillOnlyId(` ${skillOnlyId(rowId)}`)).toBe(false)
  })

  it("a one-liner id is never a skill-only id, and a spoofed one is not an added id at all", () => {
    expect(isOneLinerId(oneLinerId(rowId))).toBe(true)
    expect(isSkillOnlyId(oneLinerId(rowId))).toBe(false)
    expect(isAddedId(oneLinerId(rowId))).toBe(true)
    expect(isAddedId(`ADDED:S:${rowId}`)).toBe(false)
    expect(isAddedId("added:s")).toBe(false)
    expect(isAddedId(rowId)).toBe(false)
  })

  it("the row id is unwrapped only for an exact added id", () => {
    expect(addedRowId(skillOnlyId(rowId))).toBe(rowId)
    expect(addedRowId(oneLinerId(rowId))).toBe(rowId)
    expect(addedRowId(`ADDED:S:${rowId}`)).toBe(`ADDED:S:${rowId}`)
  })
})
