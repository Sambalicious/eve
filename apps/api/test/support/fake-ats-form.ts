import type { SchemaQuestion } from "../../src/submission/answer-assignment.js"
import type { FormControl, FormRead, FormSession, FormSessionFactory, PageAfterSubmit } from "../../src/submission/form-session.js"
import type { QuestionSchemaSource } from "../../src/submission/question-schema.js"

/**
 * An in-process fake Greenhouse/Lever/Ashby form behind the FormSession seam.
 * No network, no real employer host. Variants cover the slice 5 fixture list:
 * login, CAPTCHA, assessment, declaration, personal data, cover letter
 * accepted/absent, no confirmation, CAPTCHA after submit, injected instruction,
 * redirect, early submit, value tampering.
 */
export type FakeFormSpec = Readonly<{
  host: string
  text?: string
  controls: readonly FormControl[]
  submitControls?: number
  /** Text shown after the click. Default: a confirmation page. */
  afterSubmit?: string
  /** After the click the form comes back (validation error re-render), SEC-501. */
  afterSubmitRerender?: boolean
  /** Host of the page after the click (SEC-502). Default: the current host. */
  afterSubmitHost?: string
  /** Redirect to this host after the first fill. */
  redirectTo?: string
  /** The page's own script trips the submit guard. */
  guardTrips?: boolean
  /** The page rewrites this field after it is filled. */
  tamper?: Readonly<{ ref: string; value: string }>
  /** The click call throws (it may still have reached the employer). */
  clickThrows?: boolean
  /** Called before the click returns, to simulate a crash or a pause at that point. */
  onClick?: () => Promise<void> | void
  /** Called when the page opens, to hold a session open (concurrency tests). */
  onOpen?: () => Promise<void> | void
  /** Called after each fill or attach, with the control's ref (SEC-017: a save that lands while the form is filled). */
  onFill?: (ref: string) => Promise<void> | void
  /** The employer's question schema as the ATS API would return it (scope 05d). Default: STANDARD_SCHEMA. Null: none. */
  schema?: readonly SchemaQuestion[] | null
  /** The page rewrites its controls after the first fill (labels or name/id changed after the read, SEC-514). */
  controlsAfterFill?: readonly FormControl[]
}>

export class FakeAtsForms implements FormSessionFactory {
  private spec: FakeFormSpec | null = null
  readonly clicks: string[] = []
  readonly filled: Array<Readonly<{ ref: string; value: string }>> = []
  readonly attached: Array<Readonly<{ ref: string; path: string }>> = []
  opened = 0
  /** Schema reads by backend code (scope 05d). */
  schemaReads = 0
  /** The fake ATS question API, keyed to the current spec. */
  readonly questionSchemas: QuestionSchemaSource = {
    forPosting: async ({ applicationSystem }) => {
      this.schemaReads += 1
      // As the real reader: only Greenhouse publishes a question schema.
      if (applicationSystem !== "greenhouse") return null
      const schema = this.spec?.schema
      return schema === undefined ? STANDARD_SCHEMA : schema
    },
  }
  /** Sessions created and not yet closed, and the most ever open at once (SEC-503). */
  active = 0
  maxActive = 0

  use(spec: FakeFormSpec): void {
    this.spec = spec
    this.clicks.length = 0
    this.filled.length = 0
    this.attached.length = 0
    this.opened = 0
    this.schemaReads = 0
    this.active = 0
    this.maxActive = 0
  }

  async create(attemptId: string): Promise<FormSession> {
    const spec = this.spec
    if (!spec) throw new Error("no fake form configured")
    const values: Record<string, string> = {}
    let host = spec.host
    let fills = 0
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    const read = (): FormRead => ({
      host,
      text: spec.text ?? "Apply for this job",
      controls: fills > 0 && spec.controlsAfterFill ? spec.controlsAfterFill : spec.controls,
      submitControls: spec.submitControls ?? 1,
      guardTripped: spec.guardTrips === true && fills > 0,
    })
    return {
      open: async () => {
        this.opened += 1
        await spec.onOpen?.()
        return read()
      },
      fill: async (ref, value) => {
        values[ref] = value
        this.filled.push({ ref, value })
        fills += 1
        if (spec.redirectTo) host = spec.redirectTo
        if (spec.tamper && spec.tamper.ref === ref) values[ref] = spec.tamper.value
        await spec.onFill?.(ref)
      },
      attach: async (ref, document) => {
        values[ref] = document.name
        this.attached.push({ ref, path: document.name })
        fills += 1
        await spec.onFill?.(ref)
      },
      readValues: async () => ({ form: read(), values: { ...values } }),
      clickSubmit: async () => {
        this.clicks.push(attemptId)
        await spec.onClick?.()
        if (spec.clickThrows) throw new Error("click transport error")
      },
      waitForResult: async (): Promise<PageAfterSubmit> => ({
        host: spec.afterSubmitHost ?? host,
        text: spec.afterSubmit ?? "Thank you for applying to Acme Payments",
        formPresent: spec.afterSubmitRerender === true,
        validationErrors: spec.afterSubmitRerender === true,
      }),
      saveEvidence: async (stage) => [`${attemptId}-${stage}.yml`],
      close: async () => {
        this.active -= 1
      },
    }
  }
}

export const STANDARD_FORM: readonly FormControl[] = [
  { ref: "first", label: "First name", kind: "text", required: true },
  { ref: "last", label: "Last name", kind: "text", required: true },
  { ref: "email", label: "Email", kind: "text", required: true },
  { ref: "phone", label: "Phone", kind: "text", required: true },
  { ref: "resume", label: "Resume/CV", kind: "file", required: true },
  { ref: "location", label: "Where are you currently located?", kind: "text", required: true },
  { ref: "sponsor", label: "Will you now or in the future require visa sponsorship?", kind: "select", required: true, fieldName: "question_sponsor", fieldId: "question_sponsor" },
]

/** Greenhouse's schema for STANDARD_FORM: the sponsorship question, matched to its control by name. */
export const STANDARD_SCHEMA: readonly SchemaQuestion[] = [{ text: "Will you now or in the future require visa sponsorship?", fieldName: "question_sponsor", options: ["Yes", "No"] }]
