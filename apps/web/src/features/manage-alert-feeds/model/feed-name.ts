import type { AlertFeed } from "@/entities/stack-post"
import { FEED_LIST_COPY, type FeedList } from "./feed-list"

/** The feed's label, or the list's fallback name when it has none (C-SP-FEED-FALLBACK-NAME, C-HP-FEED-FALLBACK-NAME). */
export function feedName(feed: Pick<AlertFeed, "label">, list: FeedList = "stack"): string {
  return feed.label ?? FEED_LIST_COPY[list].fallbackName
}
