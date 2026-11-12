/**
 * Browsers word a failed `import()` differently: Chrome "Failed to fetch
 * dynamically imported module", Safari "Importing a module script failed",
 * Firefox "error loading dynamically imported module".
 */
const CHUNK_LOAD_ERROR =
  /dynamically imported module|importing a module script failed/i

/** A page's code chunk failed to download, usually because a newer build replaced it. */
export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_LOAD_ERROR.test(error.message)
}

const RELOAD_KEY = "eve:chunk-reload-at"
/** A reload that fails again within this window shows the error instead of looping. */
const RELOAD_WINDOW_MS = 10_000

/**
 * Reload at most once per window, so a stale tab picks up the new build
 * without the Candidate seeing an error, but a broken deploy can't loop.
 */
export function claimChunkReload(storage: Storage, now = Date.now()): boolean {
  try {
    const stored = storage.getItem(RELOAD_KEY)
    const last = stored === null ? Number.NaN : Number(stored)
    if (Number.isFinite(last) && now - last < RELOAD_WINDOW_MS) return false
    storage.setItem(RELOAD_KEY, String(now))
    return true
  } catch {
    return false
  }
}
