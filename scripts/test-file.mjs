#!/usr/bin/env node
// Runs one test file and fails when zero tests executed.
// Usage: node scripts/test-file.mjs --filter @eve/api --file test/outreach.int-spec.ts [--project integration]
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export function countFromOutput(text) {
  if (/No test files found/i.test(text)) return { files: 0, tests: 0 }
  const value = (label) =>
    new RegExp(`^\\s*${label}\\s+(.+)$`, "m").exec(text)?.[1] ?? null
  // Skipped and todo tests are not executed. Counting them let a file where every test is skipped
  // report as executed, which is the failure this wrapper exists to prevent.
  const total = (line) => {
    if (line === null) return null
    const count = (label) => Number(new RegExp(`(\\d+) ${label}`).exec(line)?.[1] ?? 0)
    return count("failed") + count("passed")
  }
  return { files: total(value("Test Files")), tests: total(value("Tests")) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const flag = (name) => {
    const at = args.indexOf(name)
    return at === -1 ? null : args[at + 1]
  }
  const filter = flag("--filter")
  const file = flag("--file")
  const project = flag("--project")
  if (!filter || !file) {
    process.stderr.write(
      "usage: node scripts/test-file.mjs --filter <pkg> --file <path> [--project <name>]\n"
    )
    process.exit(1)
  }
  const command = [
    "--filter",
    filter,
    "exec",
    "vitest",
    "run",
    ...(project ? ["--project", project] : []),
    file,
  ]
  const result = spawnSync("pnpm", command, { encoding: "utf8", stdio: "pipe" })
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  const counts = countFromOutput(output)
  const tail = output.trim().split("\n").slice(-6).join("\n")
  if (counts.tests === null) {
    process.stderr.write(
      `test-file: could not read a summary from vitest.\n${tail}\n`
    )
    process.exit(2)
  }
  process.stdout.write(
    `${counts.files ?? "?"} file(s), ${counts.tests} test(s) executed.\n`
  )
  if (counts.tests === 0) {
    process.stderr.write(
      `test-file: zero tests matched "${file}". A green run here proves nothing.\n`
    )
    process.exit(2)
  }
  process.exit(result.status === 0 ? 0 : 1)
}
