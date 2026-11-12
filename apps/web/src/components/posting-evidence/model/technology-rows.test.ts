import { describe, expect, it } from "vitest"

import { orderTechnologies } from "./technology-rows"

const tech = (name: string, inCriteria = false) => ({ name, quote: `uses ${name}`, inCriteria })

describe("orderTechnologies", () => {
  it("puts matched technologies first and keeps stored order inside each group", () => {
    const ordered = orderTechnologies([tech("AWS"), tech("React", true), tech("Docker"), tech("TypeScript", true)])
    expect(ordered.map((t) => t.name)).toEqual(["React", "TypeScript", "AWS", "Docker"])
  })

  it("keeps the list unchanged when nothing matches", () => {
    expect(orderTechnologies([tech("Go"), tech("Rust")]).map((t) => t.name)).toEqual(["Go", "Rust"])
  })
})
