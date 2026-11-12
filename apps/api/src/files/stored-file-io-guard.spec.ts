import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

/**
 * F-SEC-03 recheck: the submission upload used copyFile on a stored path and
 * followed a planted symlink out of the file root. Stored files are read only
 * through CandidateFiles (O_NOFOLLOW, real directories). These primitives copy
 * or stream by path and follow symlinks, so no source file outside the specs
 * imports them.
 */
const SRC = fileURLToPath(new URL("..", import.meta.url))
const FOLLOWING_PRIMITIVES = /\b(copyFile|copyFileSync|cp|cpSync|createReadStream|symlink|link)\b/

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? sources(join(directory, entry.name)) : Promise.resolve([join(directory, entry.name)]))))
  return nested.flat().filter((file) => file.endsWith(".ts") && !file.endsWith(".spec.ts"))
}

/** The names a file imports from node:fs or node:fs/promises (named, or a namespace member used later). */
function fsImports(code: string): string[] {
  const names: string[] = []
  for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/g)) names.push(...match[1]!.split(",").map((name) => name.trim().split(/\s+as\s+/)[0]!).filter(Boolean))
  for (const match of code.matchAll(/import\s*\*\s*as\s*(\w+)\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/g)) for (const use of code.matchAll(new RegExp(`\\b${match[1]}\\.(\\w+)`, "g"))) names.push(use[1]!)
  for (const match of code.matchAll(/import\s+(\w+)\s+from\s*["'](?:node:)?fs(?:\/promises)?["']/g)) for (const use of code.matchAll(new RegExp(`\\b${match[1]}\\.(\\w+)`, "g"))) names.push(use[1]!)
  return names
}

describe("stored-file I/O goes through CandidateFiles (F-SEC-03)", () => {
  it("no source file imports a path-copying or streaming fs primitive", async () => {
    const offenders: string[] = []
    for (const file of await sources(SRC)) {
      for (const name of fsImports(await readFile(file, "utf8"))) if (FOLLOWING_PRIMITIVES.test(name)) offenders.push(`${relative(SRC, file)}: ${name}`)
    }
    expect(offenders).toEqual([])
  })

  it("the scanner sees named, aliased, namespace and default imports", () => {
    expect(fsImports(`import { copyFile, mkdir } from "node:fs/promises"`)).toContain("copyFile")
    expect(fsImports(`import { copyFile as c } from "fs/promises"`)).toContain("copyFile")
    expect(fsImports(`import * as fs from "node:fs"\nfs.createReadStream(p)`)).toContain("createReadStream")
    expect(fsImports(`import fs from "node:fs"\nfs.cpSync(a, b)`)).toContain("cpSync")
  })
})
