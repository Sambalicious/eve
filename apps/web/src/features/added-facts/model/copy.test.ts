import { describe, expect, it } from "vitest"

import { addedFactsCopy, atsAddedCopy, roleLabel, roleOptionLabel } from "./copy"

describe("FEAT-0017 copy helpers", () => {
  it("joins a role as the row reads it and as the picker lists it", () => {
    expect(roleLabel({ title: "Frontend Engineer", employer: "Acme Ltd" })).toBe("Frontend Engineer, Acme Ltd")
    expect(roleLabel({ title: "Frontend Engineer", employer: null })).toBe("Frontend Engineer")
    expect(roleOptionLabel({ title: "Frontend Engineer", employer: "Acme Ltd" })).toBe("Frontend Engineer at Acme Ltd")
    expect(roleOptionLabel({ title: "Frontend Engineer", employer: "" })).toBe("Frontend Engineer")
  })

  it("keeps the deck's plural and fixed forms", () => {
    expect(atsAddedCopy.add(1)).toBe("Add 1 skill to this job")
    expect(atsAddedCopy.add(7)).toBe("Add 7 skills to this job")
    expect(atsAddedCopy.addedOne(1)).toBe("1 skill added to this job")
    expect(atsAddedCopy.addedOther(2)).toBe("2 skills added to this job")
    expect(addedFactsCopy.count(0)).toBe("0 of 10 sentences")
    expect(addedFactsCopy.errors.tooLong(301)).toBe("That is 301 characters. The limit is 300.")
    expect(addedFactsCopy.match.profile(5, 9)).toBe("Match with your Career Profile: 5/9")
    expect(addedFactsCopy.match.withAdded(7, 9)).toBe("With the facts you added: 7/9")
    expect(addedFactsCopy.announce.removedTerm("Figma")).toBe("Fact removed. Figma is back in the list.")
  })

  it("C-AF-6 is the per-row box's visible label and C-AF-7 r2 its description, the term alone", () => {
    expect(atsAddedCopy.saveToProfile).toBe("Also add to my Career Profile (needs your approval)")
    expect(atsAddedCopy.profileDescription("Figma")).toBe("Figma")
    expect(atsAddedCopy.profileDescription("design systems")).toBe("design systems")
  })
})
