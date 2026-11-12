import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { extractWorkLabels } from "./work-labels.extract.js"
import { WORK_LABELS_FILE, WORK_SNAPSHOT_FILE, buildWorkSnapshot } from "./work-question-regression.js"

const LABELS = fileURLToPath(new URL(WORK_LABELS_FILE, import.meta.url))
const SNAPSHOT = fileURLToPath(new URL(WORK_SNAPSHOT_FILE, import.meta.url))
const update = process.env.UPDATE_GOLDEN === "1"

describe("work-question golden (EPIC-0002 A0)", () => {
  it("the label set is what the extraction script produces from the slice 5 specs and fixtures", () => {
    const current = extractWorkLabels()
    if (update) writeFileSync(LABELS, current)
    expect(current).toBe(readFileSync(LABELS, "utf8"))
  })

  it("every outcome has at least five labels", () => {
    const { rows } = JSON.parse(buildWorkSnapshot(readFileSync(LABELS, "utf8"))) as { rows: { classify: Record<string, string | null> }[] }
    const counts = new Map<string, number>()
    for (const row of rows) {
      const outcome = String(row.classify["none outside Nigeria"])
      counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
    }
    for (const outcome of ["authorized", "not_authorized", "sponsorship", "unclear", "null"]) expect(counts.get(outcome) ?? 0).toBeGreaterThanOrEqual(5)
  })

  it("the snapshot header names the base commit it was captured on", () => {
    const { capturedOn } = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { capturedOn?: string }
    expect(capturedOn).toMatch(/^main [0-9a-f]{7}\b/)
  })

  it("is byte-equal to the committed snapshot", () => {
    const current = buildWorkSnapshot(readFileSync(LABELS, "utf8"))
    if (update) writeFileSync(SNAPSHOT, current)
    expect(current).toBe(readFileSync(SNAPSHOT, "utf8"))
  })
})
