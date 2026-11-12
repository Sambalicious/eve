import {
  ALERT_FEED_VERIFICATION_PATH,
  ALERT_FEEDS_PATH,
  alertFeedsResponseSchema,
  registerAlertFeedResponseSchema,
  STACK_POSTS_PATH,
  stackPostsResponseSchema,
  type AlertFeed as AlertFeedDto,
  type AlertFeedsResponse,
  type StackPostsResponse,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { AlertFeed, AlertFeeds, RegisteredAlertFeed, StackPostsPage } from "../model/stack-post"

export async function fetchAlertFeeds(): Promise<AlertFeeds> {
  return toAlertFeeds(alertFeedsResponseSchema.parse(await (await apiRequest(ALERT_FEEDS_PATH)).json()))
}

/** `PUT` the installation-wide verification (upsert). A 400 carries `fieldErrors` on the thrown `ApiError`. */
export async function saveAlertFeedVerification(
  input: { verifiedOn: string; verificationBasis: string },
  csrfToken: string
): Promise<AlertFeeds> {
  const response = await apiRequest(ALERT_FEED_VERIFICATION_PATH, { method: "PUT", csrfToken, json: input })
  return toAlertFeeds(alertFeedsResponseSchema.parse(await response.json()))
}

/**
 * `POST` a feed. The 201 is the only response that carries the full feed URL
 * (D-E5-5); it is dropped here, so it never reaches the cache, the DOM or
 * browser storage.
 */
export async function registerAlertFeed(
  input: { url: string; label: string | null },
  csrfToken: string
): Promise<RegisteredAlertFeed> {
  const response = await apiRequest(ALERT_FEEDS_PATH, { method: "POST", csrfToken, json: input })
  const body = registerAlertFeedResponseSchema.parse(await response.json())
  return { feed: toAlertFeed(body.feed), storedPosts: body.storedPosts }
}

/** `DELETE`; 204 also when the feed was already removed. */
export async function removeAlertFeed(id: string, csrfToken: string): Promise<void> {
  await apiRequest(`${ALERT_FEEDS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE", csrfToken })
}

/** `GET ?page=n`. The caller passes a normalised page (1 or more). */
export async function fetchStackPosts(page: number): Promise<StackPostsPage> {
  return toStackPostsPage(stackPostsResponseSchema.parse(await (await apiRequest(`${STACK_POSTS_PATH}?page=${page}`)).json()))
}

/** One page of posts as the UI uses it. Hiring posts have the same shape (api-contract.r1.md). */
export function toStackPostsPage(body: StackPostsResponse): StackPostsPage {
  return {
    items: body.items.map((item) => ({
      id: item.id,
      canonicalUrl: item.canonicalUrl,
      kind: item.kind,
      title: item.title,
      snippet: item.snippet,
      date: item.date,
      dateKind: item.dateKind,
      matchedTechnologies: [...item.matchedTechnologies],
      source: item.source && { label: item.source.label, maskedUrl: item.source.maskedUrl },
    })),
    page: body.page,
    totalCount: body.totalCount,
    totalPages: body.totalPages,
  }
}

function toAlertFeeds(body: AlertFeedsResponse): AlertFeeds {
  return {
    verification: body.verification && {
      verifiedOn: body.verification.verifiedOn,
      basis: body.verification.verificationBasis,
    },
    feeds: body.feeds.map(toAlertFeed),
    limit: body.limit,
    globalPaused: body.globalPaused,
  }
}

/** Picks only the row fields; a `url` on the registration DTO is never copied. */
export function toAlertFeed(feed: AlertFeedDto): AlertFeed {
  return {
    id: feed.id,
    label: feed.label,
    maskedUrl: feed.maskedUrl,
    lastReadAt: feed.lastReadAt,
    failure: feed.failure && { reason: feed.failure.reason, at: feed.failure.at },
  }
}
