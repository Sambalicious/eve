import { registerAlertFeedResponseSchema } from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import {
  HIRING_ALERT_FEEDS_PATH,
  HIRING_FEED_VERIFICATION_PATH,
  HIRING_POSTS_PATH,
  hiringAlertFeedsResponseSchema,
  hiringPostsResponseSchema,
  type HiringAlertFeedsResponse,
} from "@/shared/lib/hiring-contracts"
import type { AlertFeeds, RegisteredAlertFeed, StackPostsPage } from "../model/stack-post"
import { toAlertFeed, toStackPostsPage } from "./stack-post-repository"

/**
 * EPIC-0007 Phase 3 (api-contract.r1.md): the session Candidate's own Hiring
 * Alert feeds, her own permitted-use record and her Hiring posts. The shapes
 * equal the Stack posts ones, so the same domain types serve both lists. No
 * function takes or sends a Candidate id or a role.
 */

/** `GET /v1/stack-posts/hiring-feeds`: `verification` is the caller's own record, or null until she records it. */
export async function fetchHiringAlertFeeds(): Promise<AlertFeeds> {
  return toHiringFeeds(hiringAlertFeedsResponseSchema.parse(await (await apiRequest(HIRING_ALERT_FEEDS_PATH)).json()))
}

/** `PUT …/hiring-feeds/verification` (upsert of the caller's own row). A 400 carries every field error at once. */
export async function saveHiringFeedVerification(
  input: { verifiedOn: string; verificationBasis: string },
  csrfToken: string
): Promise<AlertFeeds> {
  const response = await apiRequest(HIRING_FEED_VERIFICATION_PATH, { method: "PUT", csrfToken, json: input })
  return toHiringFeeds(hiringAlertFeedsResponseSchema.parse(await response.json()))
}

/**
 * `POST …/hiring-feeds` (body and 201 reuse the EPIC-0005 registration schemas).
 * The full URL in the 201 is dropped here, so it never reaches the cache or the DOM (AC 6.4).
 */
export async function registerHiringAlertFeed(
  input: { url: string; label: string | null },
  csrfToken: string
): Promise<RegisteredAlertFeed> {
  const response = await apiRequest(HIRING_ALERT_FEEDS_PATH, { method: "POST", csrfToken, json: input })
  const body = registerAlertFeedResponseSchema.parse(await response.json())
  return { feed: toAlertFeed(body.feed), storedPosts: body.storedPosts }
}

/** `DELETE …/hiring-feeds/{id}`; 204 also for an unknown or already removed id. */
export async function removeHiringAlertFeed(id: string, csrfToken: string): Promise<void> {
  await apiRequest(`${HIRING_ALERT_FEEDS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE", csrfToken })
}

/** `GET …/hiring-posts?page=n`. The caller passes a normalised page (1 or more). */
export async function fetchHiringPosts(page: number): Promise<StackPostsPage> {
  return toStackPostsPage(hiringPostsResponseSchema.parse(await (await apiRequest(`${HIRING_POSTS_PATH}?page=${page}`)).json()))
}

function toHiringFeeds(body: HiringAlertFeedsResponse): AlertFeeds {
  return {
    verification: body.verification && { verifiedOn: body.verification.verifiedOn, basis: body.verification.verificationBasis },
    feeds: body.feeds.map(toAlertFeed),
    limit: body.limit,
    globalPaused: body.globalPaused,
  }
}
