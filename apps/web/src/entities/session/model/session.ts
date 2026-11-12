/** The signed-in Candidate's dashboard session, as the dashboard needs it. */
export interface Session {
  /** Sent as the CSRF header on every state-changing request. Fixed for the session's life. */
  readonly csrfToken: string
}
