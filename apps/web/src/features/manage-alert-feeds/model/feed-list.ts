import {
  alertFeedsQueryKey,
  hiringAlertFeedsQueryKey,
  hiringCopy as h,
  hiringPostsQueryKey,
  registerAlertFeed,
  registerHiringAlertFeed,
  removeAlertFeed,
  removeHiringAlertFeed,
  saveAlertFeedVerification,
  saveHiringFeedVerification,
  stackPostsCopy as c,
  stackPostsQueryKey,
} from "@/entities/stack-post"

/**
 * Which feed list a component serves: EPIC-0005 Stack posts Alert feeds, or
 * EPIC-0007 Hiring Alert feeds (design-spec r2 H6, H6b). The list picks copy
 * and endpoints only; fields, rules, layout and focus are shared.
 */
export type FeedList = "stack" | "hiring"

export interface FeedListCopy {
  readonly fallbackName: string
  readonly feedsNone: string
  readonly urlHelp: string
  readonly errLimit: string
  /** `url/in_other_list` from this list's endpoint names the other list (design-spec r2 H6a step 3). */
  readonly errOtherList: string
  readonly errNet: string
  readonly added: string
  readonly removeTitle: string
  readonly removeBody: (name: string, maskedUrl: string) => string
  readonly removeDone: string
  readonly removeErrNet: string
  readonly verifyDialogTitle: string
  /** The dialog's first body line and its description (EPIC-0008: both lists have one). */
  readonly verifyDialogHelp: string
  readonly verifySubmit: string
  readonly verifySaved: string
  readonly verifyErrNet: string
}

export const FEED_LIST_COPY: Readonly<Record<FeedList, FeedListCopy>> = {
  stack: {
    fallbackName: c.feedFallbackName,
    feedsNone: c.feedsNone,
    urlHelp: c.feedUrlHelp,
    errLimit: c.feedErrLimit,
    errOtherList: c.feedErrOtherList,
    errNet: c.feedErrNet,
    added: c.feedAdded,
    removeTitle: c.removeTitle,
    removeBody: c.removeBody,
    removeDone: c.removeDone,
    removeErrNet: c.removeErrNet,
    verifyDialogTitle: c.verifyDialogTitle,
    verifyDialogHelp: c.verifyDialogHelp,
    verifySubmit: c.verifySubmit,
    verifySaved: c.verifySaved,
    verifyErrNet: c.verifyErrNet,
  },
  hiring: {
    fallbackName: h.feedFallbackName,
    feedsNone: h.feedsNone,
    urlHelp: h.feedUrlHelp,
    errLimit: h.feedErrLimit,
    errOtherList: h.feedErrOtherList,
    errNet: h.feedErrNet,
    added: h.feedAdded,
    removeTitle: h.removeTitle,
    removeBody: h.removeBody,
    removeDone: h.removeDone,
    removeErrNet: h.removeErrNet,
    verifyDialogTitle: h.verifyDialogTitle,
    verifyDialogHelp: h.verifyDialogHelp,
    verifySubmit: h.verifySubmit,
    verifySaved: h.verifySaved,
    verifyErrNet: h.verifyErrNet,
  },
}

/** Endpoints and caches per list. Hiring writes refresh only Hiring data, Stack posts writes only Stack posts data. */
export const FEED_LIST_API = {
  stack: {
    feedsKey: alertFeedsQueryKey,
    postsKey: stackPostsQueryKey,
    saveVerification: saveAlertFeedVerification,
    register: registerAlertFeed,
    remove: removeAlertFeed,
  },
  hiring: {
    feedsKey: hiringAlertFeedsQueryKey,
    postsKey: hiringPostsQueryKey,
    saveVerification: saveHiringFeedVerification,
    register: registerHiringAlertFeed,
    remove: removeHiringAlertFeed,
  },
} as const satisfies Record<FeedList, unknown>
