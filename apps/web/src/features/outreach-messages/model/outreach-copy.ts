import type { OutreachKind } from "@eve/contracts"

/**
 * The EPIC-0014 copy deck, by key (`copy-deck.md`, `C-OM-1` to `C-OM-53`).
 * Every string is the deck's, verbatim. Placeholders are filled by code, never
 * reworded. `C-OM-38` renders no string by design, so it is absent.
 */
export interface OutreachKindCopy {
  label: string
  lower: string
  purpose: string
  /** The panel's accessible name; the application name comes from `applicationName`. */
  name: (application: string) => string
}

export const outreachCopy = {
  heading: "Outreach",
  description:
    "Short texts for this Application, written from your approved Career Profile. You copy and send them yourself. Eve sends nothing.",
  linkNote: "This text has no links or sign-off. Add your own before sending it.",
  kinds: {
    referral_request: {
      label: "Referral request",
      lower: "referral request",
      purpose: "For an employee of the company. It asks if they would refer you, and is easy to decline.",
      name: (application: string) => `Referral request for ${application}`,
    },
    introduction: {
      label: "Introduction",
      lower: "introduction",
      purpose: "For a hiring manager or decision maker. It says what you bring and asks for a short conversation.",
      name: (application: string) => `Introduction for ${application}`,
    },
    application_note: {
      label: "Application note",
      lower: "application note",
      purpose: "For a form field, or the body of an email application. It says what you bring.",
      name: (application: string) => `Application note for ${application}`,
    },
  } satisfies Record<OutreachKind, OutreachKindCopy>,
  name: {
    label: "Their name",
    hint: "Optional. Used in the greeting. Eve never fills this in.",
    save: "Save name",
    saving: "Saving…",
    savedAnnounce: "Name saved. The greeting uses it.",
    clearedAnnounce: "Name cleared.",
    unsaved: "Name not saved. Save it before you copy or email a text.",
    refused: "Use letters, spaces, hyphens, apostrophes and full stops, up to 40 characters.",
    saveFailed: "The name wasn't saved. Try again.",
  },
  write: "Write",
  writeAgain: "Write again",
  writing: (kind: string) => `Writing your ${kind}. This usually takes under a minute.`,
  writingButton: "Writing…",
  empty: "Nothing written yet.",
  tab: { writing: "Writing", notice: "Needs a look" },
  cause: {
    notApproved: (kind: string) => `The ${kind} wasn't written: Anthropic isn't approved, so no career data was sent.`,
    notConfigured: (kind: string) =>
      `The ${kind} wasn't written: the Anthropic API key is missing on the server, so no career data was sent. Add it to the server's environment, then try again.`,
    providerError: (kind: string) => `The ${kind} wasn't written: Anthropic didn't answer. Try again in a few minutes.`,
    timedOut: (kind: string) => `The ${kind} wasn't written: Anthropic took too long. Try again in a few minutes.`,
    invalidOutput: (kind: string) =>
      `The ${kind} wasn't written: Anthropic's reply wasn't in a form Eve could use, so nothing was kept. Write it again.`,
    noProfile: (kind: string) => `The ${kind} wasn't written: you don't have an approved Career Profile yet.`,
    blocked: (kind: string) =>
      `The ${kind} wasn't kept: it failed Eve's checks, so nothing was copied or sent. If a claim is true of you, add that fact to your Career Profile. A new run can differ.`,
    overBudget: (kind: string, max: number) =>
      `The ${kind} wasn't kept: it came out longer than ${max} characters, and Eve doesn't cut sentences short. Write it again.`,
    interrupted: (kind: string) =>
      `The ${kind} wasn't written: the server restarted while it was being written. Nothing was lost.`,
    other: (kind: string) => `The ${kind} wasn't written. Write it again.`,
    earlierKept: (kind: string) => `Your earlier ${kind} is unchanged.`,
    /** `C-OM-53`. The colon is part of the string; code adds none. */
    blockedQuoteLabel: "The first sentence that failed Eve's checks:",
  },
  pause: {
    global: (kind: string) =>
      `Eve is paused, so the ${kind} wasn't written. Nothing was sent to anyone. Once automation is resumed, write it again.`,
    cost: (kind: string) =>
      `Paid automation is paused for this month's cost ceiling, so the ${kind} wasn't written. Nothing was sent to anyone.`,
    costLink: "Review cost ceiling",
  },
  stale: (from: number, to: number) => `Written from Career Profile version ${from}. Your approved version is now ${to}. Write again to use it.`,
  copyFailed: "Couldn't copy. Select the text and copy it yourself.",
  copiedAnnounce: (kindLabel: string) => `${kindLabel} copied.`,
  linkTooLong: "This is too long to open in an email app. Copy it instead.",
  meta: {
    count: (count: number, max: number) => `${count} of ${max} characters`,
    written: (date: string) => `Written ${date}`,
  },
  copy: "Copy",
  copied: "Copied",
  openInEmail: "Open in email",
  writtenAnnounce: (kind: string) => `Your ${kind} is ready to copy.`,
  textLabel: (kind: string) => `Text of the ${kind}`,
  tabsLabel: "Kind of text",
  links: {
    approve: "Review and approve",
    careerProfile: "Go to Career Profile",
  },
} as const

/** The deck's `{kind}`: the lower-case name, mid-sentence. */
export function kindLower(kind: OutreachKind): string {
  return outreachCopy.kinds[kind].lower
}

/** The deck's `{Kind}`: the sentence-case label. */
export function kindLabel(kind: OutreachKind): string {
  return outreachCopy.kinds[kind].label
}
