/** `landing.request.*` form strings from copy-deck.r2.md, exact. The shell's title, close, load error and retry live in the landing page. */
export const requestCopy = {
  intro: "Your request goes to the person who runs Eve. They decide who gets an invite.",
  emailLabel: "Email",
  emailPlaceholder: "name@example.com",
  emailError: {
    required: "Enter your email address.",
    format: "Enter an email like name@example.com",
    too_long: "Email is too long. Use a shorter address.",
  },
  noteLabel: "Note (optional)",
  noteHint: "Who you are, or how you heard about Eve.",
  noteCounter: (count: number) => (count === 1 ? "1 character left" : `${count} characters left`),
  noteCounterOver: (count: number) => (count === 1 ? "1 character too many" : `${count} characters too many`),
  noteErrorTooLong: "Keep the note to 500 characters or fewer.",
  honeypotLabel: "Leave this field empty",
  /** `landing.request.privacy_notice` before `{privacy_link}`. */
  privacyNotice:
    "Eve stores only your email and note, for 90 days, and uses them only to reply. Your IP address is hashed and kept 24 hours to limit abuse. ",
  privacyLink: "Privacy",
  privacyLinkNewTab: ", opens in a new tab",
  cancel: "Cancel",
  submit: "Send request",
  submitPending: "Sending request…",
  successHeading: "Request sent",
  successBody: "The person who runs Eve will see it.",
  successClose: "Close",
  panel: {
    network: "Couldn't send your request. What you typed is still here.",
    rate_ip: "Too many requests from this network. Try again later.",
    rate_global: "Eve can't take more requests today. Try again tomorrow.",
    rejected: "This page couldn't send your request. Reload the page and send it again.",
  },
  retry: "Try again",
} as const
