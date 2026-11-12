import { describe, expect, it } from "vitest"

import { expiryNote } from "./expiry-note"

describe("expiryNote (detail suffix C-RET-15 / C-RET-15b)", () => {
  const base = { expiresOn: "2026-10-20", waiting: false, inFlight: false }
  it.each([
    ["before the date, waiting", { ...base, today: "2026-10-19", waiting: true }, null],
    ["on the date, waiting", { ...base, today: "2026-10-20", waiting: true }, "waiting"],
    ["12 days past, waiting (E5.8 gap)", { ...base, today: "2026-11-01", waiting: true }, "waiting"],
    ["past, generating", { ...base, today: "2026-10-21", inFlight: true }, "inFlight"],
    ["past, nothing holds it (the next run deletes it)", { ...base, today: "2026-10-21" }, null],
    ["before the date, generating", { ...base, today: "2026-10-01", inFlight: true }, null],
  ] as const)("%s", (_, input, note) => {
    expect(expiryNote(input)).toBe(note)
  })
})
