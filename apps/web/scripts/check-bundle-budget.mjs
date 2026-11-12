#!/usr/bin/env node
/**
 * Bundle budgets (EPIC-0003 architecture r1 section 3, PRD AC 7.4 to 7.6).
 * Reads dist/.vite/manifest.json and fails when:
 *  - the landing chunk plus its imports outside the entry's static closure is over 50 KB gzipped;
 *  - the request-access form chunk plus its imports outside the entry and landing closures is over 15 KB gzipped;
 *  - the form chunk is reachable from the landing closure through `imports` (eager) instead of only `dynamicImports`;
 *  - the entry's static closure grew more than 1 KB over its baseline;
 *  - the dashboard chunk moved more than 0.5 KB from its baseline (OPEN-FE-1 ruling,
 *    architecture.r1.md: raised from 0.2 KB for the required Home access-request alert).
 * Baselines are 447565f built with this script's method (gzip -9 of each built
 * file). The architecture's 171,835 B entry figure used another method and
 * single-chunk output, so it isn't comparable once Rolldown splits shared code.
 * Also reports first-load transfer for `/` (HTML, entry closure JS and CSS,
 * the modulepreloaded landing closure, the two preloaded fonts) against 400 KB.
 * Sizes are gzip -9 of the built files.
 */
import { readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(root, "dist")
const manifest = JSON.parse(readFileSync(join(dist, ".vite/manifest.json"), "utf8"))

const KB = 1024
const LIMITS = {
  landing: 50 * KB,
  form: 15 * KB,
  firstLoad: 400 * KB,
  // 447565f: index + rolldown-runtime + button, gzip -9 (measured 2026-10-21 by the frontend session).
  entryBaseline: 249_969,
  entryGrowth: 1 * KB,
  // 447565f dashboard chunk; with this epic's alert it measures 4,175 B (+385 B), recorded per OPEN-FE-1.
  dashboardBaseline: 3_790,
  dashboardDrift: 0.5 * KB,
}
const KEYS = {
  entry: "index.html",
  landing: "src/pages/landing/index.ts",
  form: "src/features/request-access/index.ts",
  dashboard: "src/pages/dashboard/index.ts",
}

const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length
const fmt = (bytes) => `${(bytes / KB).toFixed(1)} KB (${bytes} B)`

function chunk(key) {
  const entry = manifest[key]
  if (!entry) throw new Error(`check:budget: ${key} is not in the manifest`)
  return entry
}

/** Manifest keys reachable from `key` through static `imports`. */
function staticClosure(key, seen = new Set()) {
  if (seen.has(key)) return seen
  seen.add(key)
  for (const next of chunk(key).imports ?? []) staticClosure(next, seen)
  return seen
}

const jsBytes = (keys) => [...keys].reduce((sum, key) => sum + gz(chunk(key).file), 0)
const cssFiles = (keys) => [...new Set([...keys].flatMap((key) => chunk(key).css ?? []))]

const entryClosure = staticClosure(KEYS.entry)
const landingClosure = new Set([...staticClosure(KEYS.landing)].filter((key) => !entryClosure.has(key)))
const formClosure = new Set([...staticClosure(KEYS.form)].filter((key) => !entryClosure.has(key) && !landingClosure.has(key)))

const results = []
const check = (name, actual, limit, detail = "") => {
  const ok = actual <= limit
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${fmt(actual)} <= ${fmt(limit)}${detail ? `  ${detail}` : ""}`)
}

const entryBytes = jsBytes(entryClosure)
const landingBytes = jsBytes(landingClosure)
const formBytes = jsBytes(formClosure)
check("entry static closure", entryBytes, LIMITS.entryBaseline + LIMITS.entryGrowth, `(baseline ${LIMITS.entryBaseline}, +${entryBytes - LIMITS.entryBaseline} B)`)
check("landing route", landingBytes, LIMITS.landing, `[${[...landingClosure].map((k) => chunk(k).file).join(", ")}]`)
check("request-access form chunk", formBytes, LIMITS.form, `[${[...formClosure].map((k) => chunk(k).file).join(", ")}]`)

const eager = [...staticClosure(KEYS.landing)].some((key) => key === KEYS.form)
const lazyRef = [...staticClosure(KEYS.landing)].some((key) => (chunk(key).dynamicImports ?? []).includes(KEYS.form))
const formLazy = !eager && lazyRef && !entryClosure.has(KEYS.form)
results.push({ name: "form chunk is lazy", ok: formLazy })
console.log(`${formLazy ? "PASS" : "FAIL"}  form chunk reached only through dynamicImports from the landing closure (eager=${eager}, dynamic=${lazyRef})`)

// F-QA-E3B-01: Try again refetches only the form chunk under `?retry=N`, and a
// browser keeps a failed static import in its module map. So every static
// import of the form chunk must already be loaded by the time the dialog opens
// (the entry or landing closure). A separate dependency chunk that failed once
// could never be fetched again without a reload.
const formDeps = [...formClosure].filter((key) => key !== KEYS.form)
results.push({ name: "form chunk has no separate dependency chunks", ok: formDeps.length === 0 })
console.log(
  `${formDeps.length === 0 ? "PASS" : "FAIL"}  form chunk statically imports only the entry and landing closures` +
    (formDeps.length ? `  (extra: ${formDeps.map((k) => chunk(k).file).join(", ")})` : "")
)

const dashboardBytes = gz(chunk(KEYS.dashboard).file)
check("dashboard chunk drift", Math.abs(dashboardBytes - LIMITS.dashboardBaseline), LIMITS.dashboardDrift, `(now ${dashboardBytes} B, baseline ${LIMITS.dashboardBaseline} B)`)

const html = gzipSync(readFileSync(join(dist, "index.html")), { level: 9 }).length
const css = cssFiles(new Set([...entryClosure, ...landingClosure])).reduce((sum, file) => sum + gz(file), 0)
const entryClosureBytes = jsBytes(entryClosure)
const fonts = readFileSync(join(dist, "index.html"), "utf8")
  .match(/href="\/assets\/[^"]+\.woff2"/g)
  ?.map((m) => m.slice(7, -1))
  .reduce((sum, file) => sum + statSync(join(dist, file)).size, 0) ?? 0
const firstLoad = html + entryClosureBytes + css + landingBytes + fonts
check("first load of / (HTML + entry closure + CSS + landing + preloaded fonts)", firstLoad, LIMITS.firstLoad, `(html ${html}, entry closure ${entryClosureBytes}, css ${css}, landing ${landingBytes}, fonts ${fonts})`)

const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `\ncheck:budget FAILED: ${failed.map((r) => r.name).join("; ")}` : "\ncheck:budget passed")
process.exit(failed.length ? 1 : 0)
