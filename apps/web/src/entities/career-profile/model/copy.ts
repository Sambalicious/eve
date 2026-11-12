/** Counts with thousands separators, as amounts are shown ("1,284"). */
const countFormat = new Intl.NumberFormat("en-US")

/** Career Profile copy from design-spec.r3.md, copy catalogue. Exact strings. */
export const careerProfileCopy = {
  pageTitle: "Profile",
  /** AC-8.1. No copy deck slot yet: PROPOSAL, raised as BLOCKER[copywriter]. */
  pageDescription: "The facts Eve may use. Every resume and cover letter it writes comes from these and nothing else.",
  uploadDisabled: "Approve Anthropic before uploading your resume.", // C-PROFILE-1
  reviewAndApprove: "Review and approve", // C-PROFILE-1 action
  chooseResume: "Choose resume", // C-PROFILE-UP-1
  chooseAnotherFile: "Choose another file", // C-PROFILE-UP-1, after a refusal
  uploading: "Uploading…", // C-PROFILE-UP-2
  dropZoneText: "Drop your resume here. PDF or DOCX, up to 5 MB and 20 pages.", // C-PROFILE-UP-3
  replaceTitle: "Upload a new resume",
  replaceText: "Eve drafts a new version from it. Your approved profile stays in use until you approve the new draft.",
  drafting: (filename: string) => `Drafting your profile from ${filename}…`, // C-PROFILE-2
  draftNotice:
    "This is a draft. Nothing in it is used for documents or answers until you approve it. Check every fact: documents can only claim what's here.", // C-PROFILE-3
  /** C-PROFILE-4, first sentence: the fallback when no reason is known. */
  draftingFailed: "Couldn't draft a Career Profile from this file.",
  noText:
    "Couldn't draft a Career Profile from this file. It has no text the assistant can read, which usually means it's a scan or an image. Upload a PDF or DOCX with selectable text.", // C-PROFILE-4
  tooManyPages:
    "This PDF has more than 20 pages, the limit for a resume, so nothing was sent. Upload a shorter version without portfolios or case studies.", // C-PROFILE-4a
  tooManyCharacters:
    "This resume has more than 60,000 characters of text, so nothing was sent. Cut it down to the roles and facts you want employers to see, then upload it again.", // C-PROFILE-4b
  docxLimits:
    "This Word file is too big to open safely once unpacked, so nothing was sent. Large images or embedded files usually cause this. Remove them or save it as a PDF, then upload it again.", // C-PROFILE-4c
  parseLimits:
    "This file took too long to read, so nothing was sent. Save it again as a PDF from your word processor, then upload it again.", // C-PROFILE-4d
  noVerifiedFacts:
    "Couldn't draft a Career Profile from this resume. Anthropic's reply had no facts the assistant could match to your resume text. Try again, or upload a version with plainer formatting.", // C-PROFILE-4e
  storageFailed: "Couldn't save your resume on the server. Nothing was sent to Anthropic. Try again later.", // C-PROFILE-10
  storageFailedDetail:
    "Your file is fine. The server's storage needs fixing, so another try may fail the same way until it is.", // C-PROFILE-10a
  providerFailed:
    "Couldn't reach Anthropic to draft your Career Profile, so no draft was made. Your file is fine. Try again in a few minutes.", // C-PROFILE-11
  notConfigured:
    "Resume drafting isn't set up on the server yet: the Anthropic API key is missing. Nothing was sent. Add the key to the server's environment, then try again.", // C-PROFILE-12
  stillDrafting: (filename: string | null) =>
    filename
      ? `Your Career Profile is still being drafted from ${filename}. Wait for it to finish, then try again.`
      : "Your Career Profile is still being drafted. Wait for it to finish, then try again.", // C-PROFILE-14
  draftExists: (n: number) =>
    `You already have draft version ${n}. Approve or discard it before uploading a new resume.`, // C-PROFILE-15
  goToDraft: "Go to the draft", // C-PROFILE-15 link
  resumeNotUsed: (filename: string | null) =>
    filename
      ? `Your resume ${filename} wasn't used, because you saved edits first. To draft from the resume instead, discard this draft and upload the resume again.`
      : "Your resume wasn't used, because you saved edits first. To draft from the resume instead, discard this draft and upload the resume again.", // C-PROFILE-17
  tryAgain: "Try again",
  approved: (date: string) => `Approved on ${date}. Tailored Documents use only these facts.`, // C-PROFILE-5
  wrongFile: "Upload a PDF or DOCX resume up to 5 MB.", // C-VAL-PROFILE-1
  draftVersionNotice: (n: number) =>
    `Version ${n} is a draft. Version ${n - 1} stays in use until you approve this one. Applications already sent keep the version they used.`, // C-PROFILE-6
  inUseLine: (n: number, date: string) => `In use: version ${n}, approved ${date}.`, // C-PROFILE-7
  emptyFact: "Enter the fact or remove it.", // C-VAL-PROFILE-2
  pollingTimedOut: "This is taking longer than usual. Refresh later to see the result.", // C-ERR-4
  fromYourResume: "From your resume", // C-PROFILE-Q1
  writtenByYou: "Written by you", // C-PROFILE-Q2
  dropped: (d: number) =>
    `The assistant left out ${countFormat.format(d)} fact(s) or heading(s) it couldn't match to your resume: the quoted text wasn't in your resume, or it didn't contain every number, date, title, employer and name they stated. If something from your resume is missing below, add it with Edit Career Profile.`, // C-PROFILE-23
  historyDates: (created: string, approved: string | null) =>
    approved ? `Created ${created} · Approved ${approved}` : `Created ${created}`, // C-PROFILE-H1
  backToProfile: "Back to Career Profile", // C-PROFILE-H2
  versionNotFound: {
    title: "Version not found",
    text: (n: number) => `Career Profile version ${n} doesn't exist.`,
    action: "Back to Career Profile",
  }, // C-PROFILE-16
  versionLabel: (n: number) => `Version ${n}`,
  approveProfile: "Approve Career Profile",
  approveVersion: (n: number) => `Approve version ${n}`,
  editProfile: "Edit Career Profile",
  continueEditing: "Continue editing draft",
  discardDraft: "Discard draft",
  saveDraft: "Save draft",
  cancel: "Cancel",
  addFact: "Add fact",
  remove: "Remove",
  versionHistory: "Version history",
  draftSaved: (n: number) => `Draft version ${n} saved. Approve it to use it.`,
  versionApproved: (n: number) => `Version ${n} approved. New Tailored Documents use it.`,
  confirmApproveFirst: {
    title: "Approve your Career Profile?",
    body: "Every Tailored Document will be built from these facts only.",
    confirm: "Approve",
  }, // C-CONFIRM-1
  confirmApproveVersion: (n: number) => ({
    title: `Approve version ${n}?`,
    body: `New Tailored Documents will use version ${n} only. Applications already sent keep the version they used.`,
    confirm: `Approve version ${n}`,
  }), // C-CONFIRM-16
  /**
   * C-CONFIRM-17. Its body names version n-1 as staying in use. Version 1 has
   * no earlier version, so its discard (reachable only from C-PROFILE-17) shows
   * the title alone. See OPEN[designer] in the frontend report.
   */
  confirmDiscard: (n: number) => ({
    title: `Discard draft version ${n}?`,
    body: n > 1 ? `Your edits are deleted. Version ${n - 1} stays in use.` : "",
    confirm: "Discard draft",
  }), // C-CONFIRM-17
} as const
