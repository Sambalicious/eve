import { DEFAULT_SENIORITY_FLOOR, DEFAULT_TARGET_ROLE_FAMILIES } from "@eve/contracts"

/**
 * EPIC-0006 (contract v1.18.0): every Job criteria PUT carries `targetRoleFamilies`
 * and `seniorityFloor`. EPIC-0004 tests send the migrated defaults, so a save
 * changes only the three fields those tests are about.
 */
export const ROLE_RELEVANCE_DEFAULTS = Object.freeze({ targetRoleFamilies: [...DEFAULT_TARGET_ROLE_FAMILIES], seniorityFloor: DEFAULT_SENIORITY_FLOOR })
