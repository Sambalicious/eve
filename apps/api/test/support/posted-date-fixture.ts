/**
 * EPIC-0006: the posted date pre-epic ATS fixtures send (Lever `createdAt`,
 * Greenhouse `first_published`), within 60 days of every affected test clock,
 * so those postings stay visible (AC-5.5) as real, dated ATS postings are.
 */
export const FIXTURE_POSTED_ISO = "2026-10-01T09:00:00.000Z"
export const FIXTURE_POSTED_MS = Date.parse(FIXTURE_POSTED_ISO)
