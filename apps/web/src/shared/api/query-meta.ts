/**
 * Metadata on React Query queries and mutations that call the API.
 * `handlesUnauthorized` marks a caller that reacts to a 401 itself, so the
 * app-wide "send to sign-in" handler leaves that request alone.
 */
export interface ApiRequestMeta extends Record<string, unknown> {
  handlesUnauthorized?: boolean
}

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: ApiRequestMeta
    mutationMeta: ApiRequestMeta
  }
}
