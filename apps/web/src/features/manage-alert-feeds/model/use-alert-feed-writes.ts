import { useMutation, useQueryClient } from "@tanstack/react-query"

import type { AlertFeeds } from "@/entities/stack-post"
import { ensureCsrfToken } from "@/entities/session"
import { hasErrorCode } from "@/shared/api"
import { toastSuccess } from "@/shared/lib/action-failed"
import { FEED_LIST_API, FEED_LIST_COPY, type FeedList } from "./feed-list"
import { toWriteFailure, type WriteFailure } from "./write-failure"

type Handlers<T> = { onDone: (result: T) => void; onFailed: (failure: WriteFailure) => void }

/**
 * PUT the session Candidate's own permitted-use record for the list (Stack posts:
 * EPIC-0008 D15; Hiring: EPIC-0007 D14). Success
 * replaces that list's cached feeds, refetches its posts (the empty state moves on)
 * and toasts the list's saved line.
 */
export function useSaveVerification(list: FeedList | readonly FeedList[] = "stack") {
  const queryClient = useQueryClient()
  const lists: readonly FeedList[] = typeof list === "string" ? [list] : list
  const mutation = useMutation({
    mutationFn: async (input: { verifiedOn: string; verificationBasis: string }) => {
      const csrf = await ensureCsrfToken(queryClient)
      const saved: [FeedList, AlertFeeds][] = []
      // One confirmation covers every list that still lacks one: the same two requests as before, sent together.
      for (const one of lists) saved.push([one, await FEED_LIST_API[one].saveVerification(input, csrf)])
      return saved
    },
    onSuccess: (saved) => {
      for (const [one, feeds] of saved) {
        const api = FEED_LIST_API[one]
        queryClient.setQueryData(api.feedsKey, feeds)
        void queryClient.invalidateQueries({ queryKey: api.feedsKey })
        void queryClient.invalidateQueries({ queryKey: api.postsKey })
      }
      toastSuccess(FEED_LIST_COPY[lists[0]].verifySaved)
    },
  })
  const save = (input: { verifiedOn: string; verificationBasis: string }, handlers: Handlers<unknown>) =>
    mutation.mutate(input, { onSuccess: handlers.onDone, onError: (error) => handlers.onFailed(toWriteFailure(error)) })
  return { save, isSaving: mutation.isPending }
}

/**
 * POST a feed. The full URL in the 201 is dropped by the repository; the new
 * row is appended from the label, mask and last-read time only (D-E5-5). Posts
 * refetch so items stored by the registration fetch appear. A 409
 * `alert_feeds_not_verified` (stale page) refetches the feeds, so the
 * not-recorded panel returns (EPIC-0007 design-spec r2 H6b step 10; EPIC-0008
 * design-spec S2 step 9).
 */
export function useRegisterFeed(list: FeedList = "stack") {
  const queryClient = useQueryClient()
  const api = FEED_LIST_API[list]
  const mutation = useMutation({
    mutationFn: async (input: { url: string; label: string | null }) => api.register(input, await ensureCsrfToken(queryClient)),
    onSuccess: ({ feed }) => {
      queryClient.setQueryData<AlertFeeds>(api.feedsKey, (current) =>
        current && { ...current, feeds: [...current.feeds.filter((f) => f.id !== feed.id), feed] }
      )
      void queryClient.invalidateQueries({ queryKey: api.feedsKey })
      void queryClient.invalidateQueries({ queryKey: api.postsKey })
      toastSuccess(FEED_LIST_COPY[list].added)
    },
  })
  const register = (input: { url: string; label: string | null }, handlers: Handlers<unknown>) =>
    mutation.mutate(input, {
      onSuccess: handlers.onDone,
      onError: (error) => {
        if (hasErrorCode(error, "alert_feeds_not_verified"))
          void queryClient.invalidateQueries({ queryKey: api.feedsKey })
        handlers.onFailed(toWriteFailure(error))
      },
    })
  return { register, isRegistering: mutation.isPending }
}

/** DELETE a feed. Its posts stay and read "Removed feed", so posts refetch too. */
export function useRemoveFeed(list: FeedList = "stack") {
  const queryClient = useQueryClient()
  const api = FEED_LIST_API[list]
  const mutation = useMutation({
    mutationFn: async (id: string) => api.remove(id, await ensureCsrfToken(queryClient)),
    onSuccess: (_, id) => {
      queryClient.setQueryData<AlertFeeds>(api.feedsKey, (current) =>
        current && { ...current, feeds: current.feeds.filter((f) => f.id !== id) }
      )
      void queryClient.invalidateQueries({ queryKey: api.feedsKey })
      void queryClient.invalidateQueries({ queryKey: api.postsKey })
      toastSuccess(FEED_LIST_COPY[list].removeDone)
    },
  })
  const remove = (id: string, handlers: Handlers<unknown>) =>
    mutation.mutate(id, { onSuccess: handlers.onDone, onError: (error) => handlers.onFailed(toWriteFailure(error)) })
  return { remove, isRemoving: mutation.isPending }
}
