/** Sign-in copy from design-spec.r1.md, copy catalogue C-AUTH-*. Exact strings. */
export const signInCopy = {
  title: "Sign in to Eve",
  description: "Use the Google account you set up Eve with.",
  button: "Sign in with Google",
  buttonLoading: "Opening Google…",
  note: "Only one Google account can open this dashboard.",
  failed: "Sign-in didn't finish. Try again.",
  expired:
    "Your session ended. Sign in with Google again to continue where you left off.",
  refusedTitle: "This Google account can't open Eve",
  refusedWithEmail: (email: string) =>
    `You signed in as ${email}. This dashboard opens only for the Google account it was set up with. Choose that account and try again.`,
  refusedWithoutEmail:
    "This dashboard opens only for the Google account it was set up with. Choose that account and try again.",
} as const
