/**
 * Landing page strings, keyed like `copy-deck.r2.md` (`landing.hero.headline`
 * is `landingCopy.hero.headline`). Exact copy; edit the deck first.
 * The dialog's `landing.request.*` form strings live in the request-access
 * feature chunk; only the dialog shell's strings are here.
 */
export const landingCopy = {
  meta: {
    title: "Eve, the job assistant that asks instead of guessing",
    ogTitle: "Eve, the job assistant that asks instead of guessing",
    description:
      "Eve finds roles you can be hired for, writes resumes from your own record and applies up to five times a day. Access is by invite.",
    ogDescription:
      "Eve finds roles you can be hired for, writes resumes from your own record and applies up to five times a day. Access is by invite.",
    ogImageAlt: 'The Eve wordmark above the line "Applies for you. Asks instead of guessing."',
  },
  skip: { link: "Skip to content" },
  a11y: {
    homeLink: "Eve, home",
    headerNav: "Page",
    replay: "Replay animation",
    frameSummary:
      'Example with a made-up company. Eve finds a Senior Frontend Engineer posting at Quillmoor on Ashby. Location, pay and industry are met, sponsorship doesn\'t apply to a remote role, and hours are Unverified because the posting doesn\'t say. The posting is a strong core Match. A line in the tailored resume rephrases a fact from the Career Profile and keeps the same numbers. The Application becomes a Confirmed Submission, backed by a confirmation page, and Eve sends an email: "Applied: Senior Frontend Engineer at Quillmoor".',
  },
  header: {
    accessLink: "How access works",
    signIn: "Sign in",
    dashboard: "Open dashboard",
  },
  hero: {
    headline: "Applies for you. Asks instead of guessing.",
    /** The same headline split at its sentence boundary for the two-tone h1 (design-spec r3 S1 change 2). */
    headlineLines: ["Applies for you.", "Asks instead of guessing."] as const,
    subhead:
      "Eve finds roles you can be hired for and writes resumes from your record. At most five applications a day.",
    cta: "Sign in",
    ctaDashboard: "Open dashboard",
    accessLink: "How access works",
    note: "Access is by invite only. There is no sign-up.",
    /** r3 `landing.hero.fragment_eligibility` (F1 chip, aria-hidden). F2 and F3 render from frame.matchBadge and frame.statusConfirmed. */
    fragmentEligibility: "Passes Eligibility",
  },
  frame: {
    label: "Example. Made-up company and role.",
    role: "Senior Frontend Engineer",
    company: "Quillmoor",
    requisition: "QM-2047",
    meta: "Remote, EMEA · USD 4,800 to 6,200 a month · Found on Ashby",
    eligibilityTitle: "Eligibility",
    rules: [
      { key: "location", term: "Location", badge: "Met", tone: "met", wide: false },
      { key: "sponsorship", term: "Sponsorship", badge: "Not applicable", tone: "na", wide: true },
      { key: "pay", term: "Pay", badge: "Met", tone: "met", wide: false },
      { key: "hours", term: "Hours", badge: "Unverified", tone: "unverified", wide: false },
      { key: "industry", term: "Industry", badge: "Met", tone: "met", wide: true },
    ],
    matchBadge: "Strong core Match",
    matchLine: "4 of 5 core responsibilities backed by a fact (80%).",
    factLabel: "From your Career Profile",
    fact: "Led the move of a checkout app from Angular to React and cut the bundle from 1.4 MB to 610 KB.",
    lineLabel: "In the tailored resume",
    /** `landing.frame.line`, split at the deck's slash marks. */
    lineChunks: ["Led a checkout rebuild", "in React,", "cutting the bundle", "from 1.4 MB to 610 KB."],
    statusLabel: "Status",
    statusPrepared: "Prepared for you",
    statusConfirmed: "Confirmed Submission",
    evidence: "Confirmed by confirmation page",
    mailFrom: "Eve",
    mailTime: "10:42",
    mailSubject: "Applied: Senior Frontend Engineer at Quillmoor (QM-2047)",
    mailPreheader: "Your Application was submitted and the employer's receipt is confirmed.",
    replay: "Replay",
    paused: "Paused",
  },
  steps: {
    title: "How Eve works",
    items: [
      {
        title: "Find postings",
        body: "Eve reads employer job boards on Greenhouse, Lever and Ashby, remote job boards, and any link you paste.",
      },
      {
        title: "Check Eligibility and Match",
        body: "It checks each posting against your rules for location, sponsorship, pay, hours and industry, then against your Career Profile. Rules a posting doesn't address are marked Unverified.",
      },
      {
        title: "Write Tailored Documents",
        body: "It writes a resume and cover letter for each role from your Career Profile alone. It can reorder and rephrase your facts. It never invents skills, metrics, dates, titles or qualifications.",
      },
      {
        title: "Apply",
        body: "It fills in the form and submits it, at most five times a day. An Application counts as a Confirmed Submission only with evidence such as a confirmation page or an application ID.",
      },
      {
        title: "Report by email",
        body: "You get an email for every Confirmed Submission and every Blocked Application, with links to the exact documents and answers used.",
      },
    ],
  },
  stops: {
    title: "When Eve stops and asks",
    intro:
      "Some answers belong to you. When Eve reaches one, it pauses that Application, marks it Blocked and emails you. It doesn't guess.",
    reasons: [
      "A required question with no Approved Answer yet",
      "A login to an employer site",
      "Email verification",
      "A CAPTCHA",
      "An assessment or test",
      "A declaration you would have to sign",
      "A request for personal data, such as bank details or an ID number",
      "A second application at the same company",
      "A form it can't finish",
    ],
    close: "Eve doesn't create accounts, solve CAPTCHAs, take assessments or sign declarations for you.",
  },
  limits: {
    title: "Limits you control",
    intro: "Nothing goes out on its own until you've checked Eve's work.",
    items: [
      { term: "Daily cap", value: "Up to five automatic Applications a day. It's a ceiling, not a target." },
      {
        term: "Activation Gate",
        value: "You approve your Career Profile and five complete sample Applications before Eve sends anything by itself.",
      },
      { term: "Pause", value: "One switch stops all of your automation until you turn it back on." },
      {
        term: "Cost ceiling",
        value: "Running costs are capped at USD 50 a month. Paid automation pauses before that limit is crossed.",
      },
      { term: "Outcomes", value: "You record replies from employers yourself. Eve doesn't read your inbox." },
    ],
  },
  access: {
    title: "How access works",
    invite:
      "Eve is invite-only. The person who runs this installation invites people by their Google account email.",
    noSignup: "There's no sign-up form and no waitlist. Without an invite, sign-in won't let you in.",
    requestNote: "No invite? Ask the person who runs Eve. They decide on invites.",
    requestButton: "Request access",
    signedInvite: "Got an invite? Sign in with the Google account it was sent to.",
    /** `landing.access.data_line`, split around `{privacy_link}`. */
    dataLine: {
      before: "Eve sends career data to an AI provider only after you approve that provider and its terms. The ",
      after: " has the details.",
    },
    privacyLink: "Privacy page",
    cta: "Sign in",
    ctaDashboard: "Open dashboard",
  },
  footer: { privacy: "Privacy" },
  /** The dialog shell, in the landing chunk (architecture r1 FSD map). */
  request: {
    title: "Request access",
    closeLabel: "Close",
    errorLoad: "The request form couldn't load.",
    retry: "Try again",
    /** r3 `landing.request.toast_region_label`: the dialog toaster's name. */
    toastRegionLabel: "Problems sending",
  },
} as const
