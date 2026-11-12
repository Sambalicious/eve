import { useState } from "react"

/**
 * Row selection for the bulk toolbar. Selected IDs that are no longer on the
 * page (deleted, cleared) drop out on their own.
 */
export function useSelection(pageIds: readonly string[]) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const selected = pageIds.filter((id) => picked.has(id))
  const allSelected = pageIds.length > 0 && selected.length === pageIds.length
  return {
    selected,
    allSelected,
    someSelected: selected.length > 0 && !allSelected,
    isSelected: (id: string) => picked.has(id),
    toggle: (id: string, on: boolean) =>
      setPicked((current) => {
        const next = new Set(current)
        if (on) next.add(id)
        else next.delete(id)
        return next
      }),
    toggleAll: (on: boolean) => setPicked(on ? new Set(pageIds) : new Set()),
    clear: () => setPicked(new Set()),
  }
}
