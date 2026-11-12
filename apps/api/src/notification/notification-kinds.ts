import type { NotificationKind } from "../db/schema.js"

/** EPIC-0003 AC 11.24: access-request mail in band 4, the daily-cap alert in band 1. */
export const ACCESS_REQUEST_EMAIL_BAND = { access_request: 4, access_request_cap: 1 } as const

/**
 * EPIC-0002 prd.r2 email priority bands: (1) account and safety, (2) Blocked,
 * (3) Confirmed, (4) daily summary. Not enforced yet: the 400-per-24-hours cap
 * arrives with EPIC-0002 slice F, which reads this table. `satisfies` makes a
 * new kind fail to compile until it has a band. `uncertain` is never sent alone;
 * it rides in the daily summary.
 */
export const BAND_BY_KIND = {
  cost_pause: 1,
  blocked: 2,
  confirmed: 3,
  daily_summary: 4,
  uncertain: 4,
  ...ACCESS_REQUEST_EMAIL_BAND,
} as const satisfies Record<NotificationKind, 1 | 2 | 3 | 4>
