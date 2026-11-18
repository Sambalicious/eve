import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Duration-balanced sharding for the e2e job. Playwright's own --shard splits by test
 * count, which left shards at 134 to 204 tests and 250 to 360 s of test time. This
 * assigns whole spec files to shards with longest-processing-time-first over the
 * seconds recorded in spec-durations.json.
 *
 *   node support/spec-shards.ts <shard> <total>        print the spec files for one shard
 *   node support/spec-shards.ts --refresh <report>...  rewrite spec-durations.json from
 *                                                      Playwright JSON reports (one per shard)
 *
 * A spec file missing from the map is weighted at the median, so a new file is never
 * dropped; refresh the map when specs are added or change a lot.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS_DIR = path.join(HERE, "..", "tests")
export const DURATIONS_FILE = path.join(HERE, "spec-durations.json")

export type Durations = Record<string, number>

export function listSpecs(dir = TESTS_DIR): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".spec.ts")).sort()
}

function median(values: number[]): number {
  if (values.length === 0) return 1
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 1
}

/** Returns one list of spec files per shard; every spec appears in exactly one list. */
export function assignShards(specs: string[], durations: Durations, total: number): string[][] {
  if (!Number.isInteger(total) || total < 1) throw new Error(`shard total must be a positive integer, got ${total}`)
  const fallback = median(Object.values(durations))
  const weighted = specs.map((spec) => ({ spec, weight: durations[spec] ?? fallback }))
  // Heaviest first; ties broken by name so the assignment is identical on every runner.
  weighted.sort((a, b) => b.weight - a.weight || a.spec.localeCompare(b.spec))
  const shards = Array.from({ length: total }, () => ({ load: 0, specs: [] as string[] }))
  for (const { spec, weight } of weighted) {
    const lightest = shards.reduce((best, shard) => (shard.load < best.load ? shard : best))
    lightest.load += weight
    lightest.specs.push(spec)
  }
  return shards.map((shard) => shard.specs.sort())
}

interface ReportSuite {
  file?: string
  suites?: ReportSuite[]
  specs?: { tests?: { results?: { duration?: number }[] }[] }[]
}

/** Sums the last attempt's duration (seconds) of every test, per spec file. */
export function durationsFromReport(report: { suites?: ReportSuite[] }): Durations {
  const out: Durations = {}
  const walk = (suite: ReportSuite, file: string | undefined) => {
    const current = suite.file ?? file
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1)
        if (current && last?.duration) out[path.basename(current)] = (out[path.basename(current)] ?? 0) + last.duration / 1000
      }
    }
    for (const child of suite.suites ?? []) walk(child, current)
  }
  for (const suite of report.suites ?? []) walk(suite, undefined)
  return out
}

function main(argv: string[]) {
  if (argv[0] === "--refresh") {
    const reports = argv.slice(1)
    if (reports.length === 0) throw new Error("usage: spec-shards.ts --refresh <playwright-json-report>...")
    const merged: Durations = {}
    for (const file of reports) {
      for (const [spec, seconds] of Object.entries(durationsFromReport(JSON.parse(readFileSync(file, "utf8"))))) merged[spec] = (merged[spec] ?? 0) + seconds
    }
    const sorted = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)).map(([spec, seconds]) => [spec, Math.round(seconds * 10) / 10]))
    writeFileSync(DURATIONS_FILE, `${JSON.stringify(sorted, null, 2)}\n`)
    process.stdout.write(`wrote ${Object.keys(sorted).length} spec durations to ${DURATIONS_FILE}\n`)
    return
  }
  const shard = Number(argv[0])
  const total = Number(argv[1])
  if (!Number.isInteger(shard) || shard < 1 || shard > total) throw new Error("usage: spec-shards.ts <shard> <total>  (1-based)")
  const durations = JSON.parse(readFileSync(DURATIONS_FILE, "utf8")) as Durations
  const files = assignShards(listSpecs(), durations, total)[shard - 1] ?? []
  process.stdout.write(`${files.map((file) => `tests/${file}`).join(" ")}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
