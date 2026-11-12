/** Copy deck: Find jobs (find.*). PROPOSAL except where the deck says EXACT; edit wording here. */
export const findJobsCopy = {
  title: "Find jobs",
  description: "Search for jobs and read hiring posts. Set up alerts if you want new ones delivered.",
  stack: {
    heading: "Posts from your field",
    helper: "Posts by people who work with the tools you use. They are not job listings.",
  },
  hiring: {
    /** find.hiring.empty (PROPOSAL). */
    empty: "Hiring posts appear here once you set up job alerts. You can also use the search links above.",
  },
  stackEmpty: "Posts from your field appear here once you set up job alerts.",
  alerts: {
    heading: "Set up alerts",
    description: "Alerts bring new jobs and posts into Find jobs. You add them from Google Alerts, one feed at a time.",
    action: "Set up alerts",
    /** find.alerts.confirm.* (title EXACT per the PRD, body and button PROPOSAL). */
    confirmTitle: "Confirm you may use these feeds",
    confirmBody: "Eve reads these feeds for you. Confirm that you are allowed to use them.",
    confirmButton: "I confirm",
    /** find.alerts.feeds.* and find.alerts.hiringFeeds.* */
    feedsHeading: "Alert feeds",
    feedsEmpty: "No alert feeds yet. Add a Google Alerts feed to see posts from your field.",
    hiringFeedsHeading: "Hiring alert feeds",
    hiringFeedsEmpty: "No hiring alert feeds yet. Add one to see hiring posts.",
    unconfirmedHint: "Confirm above to add feeds.",
  },
  boards: {
    heading: "Job boards",
    description: "Eve checks these job boards every morning",
  },
} as const
