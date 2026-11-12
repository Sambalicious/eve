import { useEffect, useRef, useState } from "react"

/** design-spec r1 Motion: a removed feed row fades out over 120ms before it leaves the list. */
export const FEED_ROW_EXIT_MS = 120

export type RowPhase = "present" | "entering" | "leaving"
export type PresentRow<T> = { readonly item: T; readonly phase: RowPhase }

type Keyed = { readonly id: string }

/**
 * Keeps a removed row in place, marked `leaving`, for FEED_ROW_EXIT_MS so it can
 * fade out; marks a row added after mount `entering` so it can fade in. Rows
 * present at mount never animate. With `reducedMotion`, rows are always
 * `present` and a removed row goes at once. The final list is the same either way.
 */
export function useFeedRowPresence<T extends Keyed>(items: readonly T[], reducedMotion: boolean): PresentRow<T>[] {
  const [source, setSource] = useState(items)
  const [rows, setRows] = useState<PresentRow<T>[]>(() => items.map((item) => ({ item, phase: "present" })))

  // Derive the next rows during render when the items change (React's "adjust state on prop change" pattern).
  if (source !== items) {
    setSource(items)
    setRows(merge(rows, items, reducedMotion))
  }

  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const leavingKey = rows
    .filter((row) => row.phase === "leaving")
    .map((row) => row.item.id)
    .join(" ")

  useEffect(() => {
    const leaving = new Set(leavingKey ? leavingKey.split(" ") : [])
    const running = timers.current
    for (const [id, timer] of running) {
      if (!leaving.has(id)) {
        clearTimeout(timer)
        running.delete(id)
      }
    }
    for (const id of leaving) {
      if (running.has(id)) continue
      running.set(
        id,
        setTimeout(() => {
          running.delete(id)
          setRows((current) => current.filter((row) => !(row.item.id === id && row.phase === "leaving")))
        }, FEED_ROW_EXIT_MS)
      )
    }
  }, [leavingKey])

  useEffect(() => {
    const running = timers.current
    return () => {
      for (const timer of running.values()) clearTimeout(timer)
      running.clear()
    }
  }, [])

  return rows
}

/** Walks the previous rows in order: kept ids pull in the new items before them, missing ids stay as leaving. */
function merge<T extends Keyed>(previous: readonly PresentRow<T>[], items: readonly T[], reducedMotion: boolean): PresentRow<T>[] {
  const known = new Map(previous.map((row) => [row.item.id, row]))
  const next = new Map(items.map((item) => [item.id, item]))
  const toRow = (item: T): PresentRow<T> => {
    const before = known.get(item.id)
    if (reducedMotion || before?.phase === "leaving") return { item, phase: "present" }
    return { item, phase: before ? before.phase : "entering" }
  }
  const result: PresentRow<T>[] = []
  let cursor = 0
  for (const row of previous) {
    if (next.has(row.item.id)) {
      while (cursor < items.length) {
        const item = items[cursor++]
        result.push(toRow(item))
        if (item.id === row.item.id) break
      }
    } else if (!reducedMotion && !result.some((r) => r.item.id === row.item.id)) {
      result.push({ item: row.item, phase: "leaving" })
    }
  }
  while (cursor < items.length) result.push(toRow(items[cursor++]))
  return result
}
