import { z } from "zod"

/**
 * ADR 0016: the browser extension reports the employer form it read in the
 * Candidate's own tab, and Eve answers with the values it may type in and the
 * prepared documents it may attach.
 *
 * The extension never sends an answer, only what it saw: every `label` is page
 * text, so it is capped and classified exactly as the automatic path classifies
 * a label. The response is a plan, not a write: no Application, attempt, event
 * or ledger row changes, and the Candidate still clicks the employer's Submit.
 * `values` never carries a document; a document answer is named in `documents`,
 * and the file itself is fetched separately from the download route. No bytes
 * cross this endpoint.
 */

/** The one extension route (ADR 0016 "One new endpoint"), behind the session cookie and `x-csrf-token`. */
export const EXTENSION_FILL_PATH = "/v1/extension/fill"

/** A page's control kinds. A file input is read, then attached after the review. */
export const extensionFillFieldKindSchema = z.enum(["text", "textarea", "select", "radio", "checkbox", "file"])
export type ExtensionFillFieldKind = z.infer<typeof extensionFillFieldKindSchema>

/** The prepared documents ADR 0016 may attach, by their download route's name. */
export const extensionFillDocumentKindSchema = z.enum(["resume", "cover_letter"])
export type ExtensionFillDocumentKind = z.infer<typeof extensionFillDocumentKindSchema>

/** ADR 0016: "Field labels are treated as untrusted text and capped." */
export const EXTENSION_FILL_MAX_URL_LENGTH = 2048
export const EXTENSION_FILL_MAX_FIELDS = 200
export const EXTENSION_FILL_MAX_REF_LENGTH = 64
export const EXTENSION_FILL_MAX_LABEL_LENGTH = 300
export const EXTENSION_FILL_MAX_OPTIONS = 100
export const EXTENSION_FILL_MAX_OPTION_LENGTH = 200

/** One control as the extension's reader saw it. `ref` is the extension's own handle for the control. */
export const extensionFillFieldSchema = z
  .object({
    ref: z.string().min(1).max(EXTENSION_FILL_MAX_REF_LENGTH),
    label: z.string().max(EXTENSION_FILL_MAX_LABEL_LENGTH),
    kind: extensionFillFieldKindSchema,
    required: z.boolean(),
    options: z.array(z.string().max(EXTENSION_FILL_MAX_OPTION_LENGTH)).max(EXTENSION_FILL_MAX_OPTIONS).optional(),
    /** A text input that offers choices (role=combobox, a datalist, aria-autocomplete). Never free text. */
    combobox: z.boolean().optional(),
  })
  .strict()
export type ExtensionFillField = z.infer<typeof extensionFillFieldSchema>

/** `POST /v1/extension/fill` body: the Candidate's page URL and the controls on it. */
export const extensionFillRequestSchema = z
  .object({
    url: z.string().min(1).max(EXTENSION_FILL_MAX_URL_LENGTH),
    fields: z.array(extensionFillFieldSchema).max(EXTENSION_FILL_MAX_FIELDS),
  })
  .strict()
  .superRefine((value, ctx) => {
    // A ref is the filler's only handle: two fields with one ref make the target ambiguous.
    const seen = new Set<string>()
    value.fields.forEach((field, index) => {
      if (seen.has(field.ref)) ctx.addIssue({ code: "custom", message: "duplicate_ref", path: ["fields", index, "ref"] })
      seen.add(field.ref)
    })
  })
export type ExtensionFillRequest = z.infer<typeof extensionFillRequestSchema>

/** The Application an Eve page matched, or null when the page is not one (ADR 0016 "Matching"). */
export const extensionFillApplicationSchema = z
  .object({
    id: z.uuid(),
    company: z.string().nullable(),
    roleTitle: z.string().nullable(),
  })
  .strict()
export type ExtensionFillApplication = z.infer<typeof extensionFillApplicationSchema>

/** One value to type in, with the kind of control it belongs to. */
export const extensionFillValueSchema = z
  .object({
    ref: z.string().min(1).max(EXTENSION_FILL_MAX_REF_LENGTH),
    value: z.string(),
    kind: extensionFillFieldKindSchema,
  })
  .strict()
export type ExtensionFillValue = z.infer<typeof extensionFillValueSchema>

/**
 * One document answer, matched to the file input that asked for it. `ref` is
 * the page handle the filler attaches the file to. The page's own label never
 * travels back: the background already joined it from the read, and the
 * extension attaches the prepared PDF without naming a file.
 */
export const extensionFillDocumentSchema = z
  .object({
    ref: z.string().min(1).max(EXTENSION_FILL_MAX_REF_LENGTH),
    document: extensionFillDocumentKindSchema,
  })
  .strict()
export type ExtensionFillDocument = z.infer<typeof extensionFillDocumentSchema>

/** A control the plan could not answer, for the Candidate to fill in or answer in Eve. */
export const extensionFillUnansweredSchema = z
  .object({
    ref: z.string().min(1).max(EXTENSION_FILL_MAX_REF_LENGTH),
    label: z.string().max(EXTENSION_FILL_MAX_LABEL_LENGTH),
    /** The Candidate-facing reason (a hard block's detail or a leftover's detail), never employer text alone. */
    detail: z.string().nullable(),
  })
  .strict()
export type ExtensionFillUnanswered = z.infer<typeof extensionFillUnansweredSchema>

export const extensionFillResponseSchema = z
  .object({
    application: extensionFillApplicationSchema.nullable(),
    values: z.array(extensionFillValueSchema),
    documents: z.array(extensionFillDocumentSchema).max(EXTENSION_FILL_MAX_FIELDS),
    unanswered: z.array(extensionFillUnansweredSchema),
  })
  .strict()
export type ExtensionFillResponse = z.infer<typeof extensionFillResponseSchema>
