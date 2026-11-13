import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** The directory of this module, which is how the other tests here locate repository files. */
const here = (import.meta as ImportMeta & { dirname: string }).dirname

/**
 * Reads a copy deck from the private epic folder, or null where it does not ship.
 *
 * The copy decks are process artifacts: the public repository does not carry `epics/`, so the drift
 * checks that compare a build's copy against its deck cannot run there. They return null instead of
 * failing a build for a file the contributor was never given, and `describe.skipIf` marks the skip.
 */
export function readCopyDeck(relativePath: string): string | null {
  let dir = here
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      const path = join(dir, relativePath)
      return existsSync(path) ? readFileSync(path, "utf8") : null
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}
