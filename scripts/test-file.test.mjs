import test from "node:test"
import assert from "node:assert/strict"
import { countFromOutput } from "./test-file.mjs"

test("a passing file run is counted", () => {
  assert.deepEqual(
    countFromOutput(" Test Files  1 passed (1)\n      Tests  84 passed (84)\n"),
    { files: 1, tests: 84 }
  )
})

test("a failing file run counts its executed tests", () => {
  assert.deepEqual(
    countFromOutput(
      " Test Files  1 failed | 185 passed (186)\n      Tests  78 failed | 5069 skipped (5147)\n"
    ),
    { files: 186, tests: 78 }
  )
})

test("no matching files is zero tests, not zero failures", () => {
  assert.deepEqual(
    countFromOutput("No test files found, exiting with code 1\n"),
    { files: 0, tests: 0 }
  )
})

test("unreadable output yields null so the caller can refuse to call it green", () => {
  assert.equal(countFromOutput("something unexpected\n").tests, null)
})
