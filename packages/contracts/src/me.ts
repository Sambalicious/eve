import { z } from "zod"

/** EPIC-0002 A2 (contract v1.21.0): the session Candidate's own facts. */
export const ME_PATH = "/v1/me"
/** v1.28.0 (EPIC-0011 C2): `PUT` the per-user Advanced visibility flag. */
export const ME_ADVANCED_PATH = "/v1/me/advanced"
/** v1.28.0: notes the Candidate can dismiss. */
export const meNoteSchema = z.enum(["simpler_now", "improve_results"])
export type MeNote = z.infer<typeof meNoteSchema>
/** v1.28.0: `POST` dismisses one note. */
export const meNoteDismissPath = (note: MeNote) => `/v1/me/notes/${note}/dismiss`

/**
 * The EPIC-0001 features EPIC-0002 converts one slice at a time (architecture
 * r3/r4 "Fail closed before conversion"): `spend` in slice D, `submission` in
 * slice E, `notifications` in slice F.
 */
export const convertedFeatureSchema = z.enum(["submission", "notifications", "spend"])
export type ConvertedFeature = z.infer<typeof convertedFeatureSchema>

/** `available` for the Operator, or for anyone once the feature's converting slice has shipped. */
export const capabilitySchema = z.enum(["available", "not_yet"])
export type Capability = z.infer<typeof capabilitySchema>

/**
 * Body of `GET /v1/me` in A2. Later slices add the onboarding, consent, AI terms
 * and preferences fields; a client must ignore keys it does not know.
 */
export const meResponseSchema = z
  .object({
    candidateId: z.uuid(),
    email: z.string().nullable(),
    isOperator: z.boolean(),
    capabilities: z
      .object({
        submission: capabilitySchema,
        notifications: capabilitySchema,
        spend: capabilitySchema,
      })
      .strict(),
    /** v1.28.0 (C2): the Advanced view is on. */
    advancedEnabled: z.boolean(),
    /** v1.28.0: automatic applying is on, so Advanced cannot be turned off. */
    advancedLocked: z.boolean(),
    /** v1.28.0: show the "Eve is simpler now" note while Advanced is off. */
    simplerNoteDue: z.boolean(),
    /** v1.28.0: the "Improve your results" list was dismissed. */
    improveListDismissed: z.boolean(),
  })
  .strict()
export type MeResponse = z.infer<typeof meResponseSchema>

/** v1.28.0 (C2): body of `PUT /v1/me/advanced`. The response is a `MeResponse`. */
export const setAdvancedRequestSchema = z.object({ enabled: z.boolean() }).strict()
export type SetAdvancedRequest = z.infer<typeof setAdvancedRequestSchema>
