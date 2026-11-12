import type { FieldKind, LabelCheck, SchemaQuestion } from "./answer-assignment.js"
import type { StoredDocument } from "./stored-document.js"

/** One control of the application form, read by backend code (architecture r1 journey 2 step 3). Values are never sent to a model. */
export type FormControl = Readonly<{
  ref: string
  label: string
  kind: FieldKind
  required: boolean
  options?: readonly string[]
  /** A text input that offers choices (role=combobox, a datalist, aria-autocomplete): never free text. */
  combobox?: boolean
  labelCheck?: LabelCheck
  /** The control's name and id attributes (schema match, SEC-514 identity check). */
  fieldName?: string
  fieldId?: string
  /** Set only by backend code (`attachSchema`), from the ATS API; never read from the page. */
  schemaQuestion?: SchemaQuestion
}>

export type FormRead = Readonly<{
  /** Top-level page origin host after the call. */
  host: string
  /** Visible page text, for block detection only. */
  text: string
  controls: readonly FormControl[]
  /** Submit controls inside the application form. Exactly one is required. */
  submitControls: number
  /** True when the page's submit guard cancelled a submit the backend did not start. */
  guardTripped: boolean
}>

/** The page after the click, read by backend code for evidence (SEC-501, SEC-502). */
export type PageAfterSubmit = Readonly<{
  /** Top-level host; "" when unreadable. */
  host: string
  /** Visible text, line breaks kept. */
  text: string
  /** The application form (its tagged submit control or fields, or a form with fields and a submit control) is still on the page. */
  formPresent: boolean
  /** The page marks a field invalid or shows a field error. */
  validationErrors: boolean
}>

/**
 * The browser seam (ADR 0008). The Playwright MCP adapter implements it in the
 * worker; tests implement it with a fake ATS form. No method lets a model act:
 * the submission service calls every method itself, and `clickSubmit` is called
 * at most once per attempt, after `submitting` is committed.
 */
export interface FormSession {
  open(applyUrl: string): Promise<FormRead>
  fill(ref: string, value: string): Promise<void>
  /** Uploads a stored document; its bytes are read through CandidateFiles (F-SEC-03), never from a path. */
  attach(ref: string, document: StoredDocument): Promise<void>
  /** Re-reads the form with current values, keyed by ref. */
  readValues(): Promise<Readonly<{ form: FormRead; values: Readonly<Record<string, string>> }>>
  clickSubmit(): Promise<void>
  /** Re-reads the page after the click until `settled` says so or its time bound ends; returns the last read. */
  waitForResult(settled: (page: PageAfterSubmit) => boolean): Promise<PageAfterSubmit>
  /** Saves a snapshot and a screenshot to files (never into a prompt); returns the file names, with hashes where readable. */
  saveEvidence(stage: EvidenceStage): Promise<readonly string[]>
  close(): Promise<void>
}

export type EvidenceStage = "pre_submit" | "post_submit"

/** The page's top-level origin left the application host (ADR 0008: checked after every browser call). */
export class OffOriginError extends Error {
  constructor(readonly host: string) {
    super(`Page left the application host for ${host}`)
    this.name = "OffOriginError"
  }
}

export interface FormSessionFactory {
  /** Throws `BrowserUnavailableError` when no browser is configured. */
  create(attemptId: string): Promise<FormSession>
}

export const FORM_SESSION_FACTORY = Symbol("FORM_SESSION_FACTORY")

export class BrowserUnavailableError extends Error {
  constructor() {
    super("No browser is configured for submission")
    this.name = "BrowserUnavailableError"
  }
}

/** Default in the api and in any environment without the browser stack: nothing can be submitted. */
export const unavailableFormSessions: FormSessionFactory = {
  create: () => Promise.reject(new BrowserUnavailableError()),
}
