/**
 * FEAT-0017: the in-memory id namespace of an Application's added facts
 * (architecture "Distinct id namespace carrying the kind"). The kind travels in
 * the id string, so `checkLine` enforces placement without a new parameter at its
 * call sites: a call site cannot forget it, so there is no fail-open path.
 *
 * Profile ids are plain UUIDs, so the prefixes cannot collide. The model only
 * ever sees aliases (`F1..Fn`), never these ids, and the wire never carries them
 * (a fact is a plain UUID row id).
 */
export const SKILL_ONLY_PREFIX = "added:s:"
export const ONE_LINER_PREFIX = "added:o:"

export function skillOnlyId(rowId: string): string {
  return `${SKILL_ONLY_PREFIX}${rowId}`
}

export function oneLinerId(rowId: string): string {
  return `${ONE_LINER_PREFIX}${rowId}`
}

export function isSkillOnlyId(id: string): boolean {
  return id.startsWith(SKILL_ONLY_PREFIX)
}

export function isOneLinerId(id: string): boolean {
  return id.startsWith(ONE_LINER_PREFIX)
}

export function isAddedId(id: string): boolean {
  return isSkillOnlyId(id) || isOneLinerId(id)
}

/** The row UUID an in-memory id was built from. */
export function addedRowId(id: string): string {
  return isAddedId(id) ? id.slice(SKILL_ONLY_PREFIX.length) : id
}
