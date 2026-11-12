import { z } from "zod"

/** Header that every state-changing /v1 request must carry. */
export const CSRF_HEADER = "x-csrf-token"

/** Body of `GET /v1/session` for a signed-in Candidate. */
export const sessionResponseSchema = z
  .object({
    csrfToken: z.string().min(1),
  })
  .strict()
export type SessionResponse = z.infer<typeof sessionResponseSchema>

/** Idle expiry of a dashboard session (ADR 0007). */
export const SESSION_IDLE_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000
