import type { NotificationEmailType } from "./notification"

const EMAIL_TYPE: Record<NotificationEmailType, string> = {
  confirmed_submission: "Confirmed Submission",
  blocked_application: "Blocked Application",
  daily_summary: "daily summary",
  cost_pause: "cost pause",
}

/** Advanced off: the whole sentence is plain, with no server instruction (design-review.r1 F6; COPY PROPOSAL). */
const EMAIL_SUBJECT_PLAIN: Record<NotificationEmailType, string> = {
  confirmed_submission: "email about your application",
  blocked_application: "email about something that needs you",
  daily_summary: "daily summary email",
  cost_pause: "email about the pause",
}

/** Notification copy from design-spec.r4.md, copy catalogue C-NOTIFY-*. Exact strings. */
export const notificationCopy = {
  /** C-NOTIFY-1. */
  failure: {
    title: "An email didn't send",
    text: (emailType: NotificationEmailType, timeWat: string, plain = false) =>
      plain
        ? `The ${EMAIL_SUBJECT_PLAIN[emailType]}, sent at ${timeWat}, couldn't be delivered. Nothing was changed. Try again later or tell the person who runs your Eve.`
        : `The ${EMAIL_TYPE[emailType]} email from ${timeWat} couldn't be sent from your Gmail account. Nothing was resubmitted or changed. If this keeps happening, check the Gmail app password in the server's environment.`,
    link: "See what wasn't sent",
  },
  /** `dashboard.access_requests.*` from EPIC-0003 copy-deck.r2.md. Exact strings; ICU plurals on `count`. */
  accessRequests: {
    titleWaiting: "Access requests are waiting",
    textWaiting: (count: number) =>
      `${count === 1 ? "1 access request is waiting" : `${count} access requests are waiting`} because email isn't set up. Eve stored them and sends them once Gmail is set up in the server's environment. Eve deletes unsent requests after 90 days.`,
    titleFailed: "Access request emails didn't send",
    textFailed: (count: number) =>
      `${count === 1 ? "1 access request couldn't" : `${count} access requests couldn't`} be emailed to you from your Gmail account. The requests are stored, but Eve won't try those emails again. Check the Gmail app password in the server's environment.`,
  },
} as const
