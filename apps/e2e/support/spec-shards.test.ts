import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { assignShards, DURATIONS_FILE, durationsFromReport, listSpecs, type Durations } from "./spec-shards.ts"

const durations = JSON.parse(readFileSync(DURATIONS_FILE, "utf8")) as Durations

test("every spec file lands in exactly one shard", () => {
  const specs = listSpecs()
  const shards = assignShards(specs, durations, 6)
  assert.deepEqual(shards.flat().sort(), specs)
})

test("a spec missing from the duration map is still assigned", () => {
  const shards = assignShards(["new.spec.ts", "old.spec.ts"], { "old.spec.ts": 10 }, 2)
  assert.deepEqual(shards.flat().sort(), ["new.spec.ts", "old.spec.ts"])
})

test("recorded durations balance within 5 percent at 6 shards", () => {
  const loads = assignShards(listSpecs(), durations, 6).map((files) => files.reduce((sum, file) => sum + (durations[file] ?? 0), 0))
  assert.ok(Math.max(...loads) <= Math.min(...loads) * 1.05, `loads ${loads.join(", ")}`)
})

test("the assignment is deterministic", () => {
  assert.deepEqual(assignShards(listSpecs(), durations, 6), assignShards([...listSpecs()].reverse(), durations, 6))
})

test("durationsFromReport sums the last attempt per test by spec file", () => {
  const report = {
    suites: [
      { file: "a.spec.ts", specs: [{ tests: [{ results: [{ duration: 500 }, { duration: 1500 }] }] }], suites: [{ specs: [{ tests: [{ results: [{ duration: 1000 }] }] }] }] },
    ],
  }
  assert.deepEqual(durationsFromReport(report), { "a.spec.ts": 2.5 })
})
