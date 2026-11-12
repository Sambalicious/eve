#!/usr/bin/env node
/**
 * The built web output never contains the Operator address or a mailto link
 * (EPIC-0003 architecture r1 7.13, request-access.feature "built web output").
 * Reads every file under dist/ (including .map files) and fails on:
 *  - "mailto:";
 *  - the value of NOTIFY_TO when it is set, case-insensitively and URL-encoded;
 *  - the strings NOTIFY_TO, GMAIL_SMTP or @eve-operator.invalid.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(root, "dist")

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) yield* files(path)
    else yield path
  }
}

const needles = ["mailto:", "NOTIFY_TO", "GMAIL_SMTP", "@eve-operator.invalid"]
const operator = process.env.NOTIFY_TO?.trim()
if (operator) needles.push(operator, encodeURIComponent(operator))
const lowered = needles.map((n) => n.toLowerCase())

const hits = []
let count = 0
for (const path of files(dist)) {
  if (/\.(woff2?|png|jpe?g|gif|ico|webp)$/i.test(path)) continue
  count += 1
  const text = readFileSync(path, "utf8").toLowerCase()
  lowered.forEach((needle, i) => {
    if (text.includes(needle)) hits.push(`${relative(root, path)}: contains ${i < 4 ? needles[i] : "the NOTIFY_TO value"}`)
  })
}

if (hits.length) {
  console.error(`check:public-output FAILED\n${hits.join("\n")}`)
  process.exit(1)
}
console.log(`check:public-output passed: ${count} text files, no mailto, no Operator address${operator ? " (NOTIFY_TO checked)" : ""}`)
