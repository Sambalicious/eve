/**
 * The types that cross the extension's three contexts: the popup, the
 * background service worker, the Eve tab's injected bridge and the employer
 * tab's injected reader/filler.
 *
 * This file has no imports or exports on purpose: every other source file is a
 * classic script, because Chrome injects `files` as classic scripts.
 */

type EveFieldKind = "text" | "textarea" | "select" | "radio" | "checkbox" | "file"

/** The prepared documents the extension may attach (contract `extensionFillDocumentKindSchema`). */
type EveDocumentKind = "resume" | "cover_letter"

/** One document answer Eve planned for a file input, as the API returns it. */
interface EveFillDocument {
  ref: string
  document: EveDocumentKind
}

/** One control as the employer page's reader saw it (the API's `extensionFillFieldSchema`). */
interface EvePageField {
  ref: string
  label: string
  kind: EveFieldKind
  required: boolean
  options?: string[]
  /** A text input that offers choices (role=combobox, aria-autocomplete or a datalist). */
  combobox?: boolean
}

/** One value Eve planned, and the kind of control it belongs to. */
interface EvePageValue {
  ref: string
  value: string
  kind: EveFieldKind
}

/** One planned value as the popup reviews it: the page's own label for the ref, and the value Eve would type. */
interface EveFillPlanValue extends EvePageValue {
  label: string
}

/** One planned document as the popup reviews it: the page's label and which prepared PDF goes there. */
interface EveFillPlanDocument extends EveFillDocument {
  label: string
}

/** A downloaded document, handed to the page filler after both clicks. */
interface EvePageDocument {
  ref: string
  name: string
  type: string
  base64: string
}

/** A control Eve could not answer, with the Candidate-facing reason when Eve sent one. */
interface EvePageUnanswered {
  ref: string
  label: string
  detail?: string | null
}

interface EvePageFillPayload {
  values: EvePageValue[]
  /** The approved documents whose download succeeded; a failed download simply has no entry. */
  documents?: EvePageDocument[]
  unanswered: EvePageUnanswered[]
}

/** What the filler did: values set and verified, documents attached and verified, required fields left empty, and refs whose read-back differed. */
interface EvePageFillResult {
  filled: number
  attached: number
  unanswered: number
  mismatched: string[]
}

/** What the page reports once the last item is done: required fields still empty, counted. */
interface EvePageFinishResult {
  unanswered: number
}

/**
 * The stepped page API. The background calls one method per item, so a fill
 * that outlives the popup can be stopped between two calls. `fill` is kept as
 * their composition, for the tests and for any caller that wants one call.
 */
interface EvePageApi {
  read(): EvePageField[]
  begin(): void
  fillValue(value: EvePageValue): Promise<boolean>
  attachFile(document: EvePageDocument): Promise<boolean>
  finish(): EvePageFinishResult
  fill(payload: EvePageFillPayload): Promise<EvePageFillResult>
}

/** `POST /v1/extension/fill` body and response, as the bridge exchanges them. */
interface EveFillBody {
  url: string
  fields: EvePageField[]
}

interface EveFillApplication {
  id: string
  company: string | null
  roleTitle: string | null
}

interface EveFillResponseBody {
  application: EveFillApplication | null
  values: EvePageValue[]
  documents: EveFillDocument[]
  unanswered: EvePageUnanswered[]
}

type EveBridgeError = "unauthorized" | "session" | "csrf" | "fill" | "download" | "network" | "forbidden" | "not_available" | "too_large"

type EveBridgeResult =
  | { ok: true; status: number; body: EveFillResponseBody }
  | { ok: false; status: number; error: EveBridgeError }

/** One prepared document as the bridge downloaded it: name from the server, bytes as base64. */
type EveBridgeDownloadResult =
  | { ok: true; name: string; type: string; base64: string }
  | { ok: false; status: number; error: EveBridgeError }

interface EveBridgeApi {
  fill(body: EveFillBody): Promise<EveBridgeResult>
  download(applicationId: string, document: EveDocumentKind): Promise<EveBridgeDownloadResult>
}

/** The popup's first request: read the page and ask Eve what it would type, without typing anything. */
type EveFillPlanRequest = { type: "FILL_PLAN" }

/** The popup's second request, after the Candidate reviewed and approved the listed refs. */
type EveFillApplyRequest = { type: "FILL_APPLY"; refs: string[] }

/** The Candidate's Stop. It names no run: the worker stops whichever run it is stepping. */
type EveFillStopRequest = { type: "FILL_STOP" }

type EveExtensionRequest = EveFillPlanRequest | EveFillApplyRequest | EveFillStopRequest

/** Why a reviewed document did not reach the page. The popup turns each into one sentence. */
type EveDocumentFailureReason = "signed_out" | "not_available" | "too_large" | "unattached"

/**
 * One approved document that stayed unattached. `document` names which prepared
 * PDF it was for, so a popup reopened after the run can still say "Resume was
 * not attached". It never carries a value or a byte.
 */
interface EveDocumentFailure {
  ref: string
  document: EveDocumentKind
  reason: EveDocumentFailureReason
}

type EveFillRunStatus = "filling" | "stopping" | "done" | "stopped" | "failed"

/** One item a run is working on. The label is the plan's, never the page's after the fact. */
interface EveFillRunCurrent {
  index: number
  kind: "value" | EveDocumentKind
  label: string
}

/** What a finished run counts. The same numbers as the old one-shot summary, without its wrapper. */
interface EveFillRunSummary {
  fields: number
  filled: number
  documents: number
  attached: number
  unanswered: number
  mismatched: string[]
  failures: EveDocumentFailure[]
}

/**
 * The fill the background is stepping, in `chrome.storage.session` under
 * `fillRun`. The popup is a view of this record and of nothing else. It never
 * holds a field value and never a byte: only a plan label and the planned URL.
 */
interface EveFillRun {
  id: string
  status: EveFillRunStatus
  tabId: number
  url: string
  application: EveFillApplication
  total: number
  completed: number
  current: EveFillRunCurrent | null
  summary: EveFillRunSummary | null
  error: string | null
  startedAt: number
  updatedAt: number
}

/** The background's answer to FILL_APPLY: it claimed the run and returned; the work continues in the worker. */
type EveFillApplyAck = { ok: true; runId: string } | { ok: false; error: string }

/** The plan the background stores between the two clicks, keyed to the tab and page it was read from. */
interface EveStoredFillPlan {
  tabId: number
  url: string
  fields: number
  application: EveFillApplication
  values: EveFillPlanValue[]
  documents: EveFillPlanDocument[]
  unanswered: EvePageUnanswered[]
}

/** The background's answer to FILL_PLAN: what it would type, joined to the page label, and what it cannot answer. */
type EveFillPlanSummary =
  | {
      ok: true
      application: EveFillApplication
      fields: number
      values: EveFillPlanValue[]
      documents: EveFillPlanDocument[]
      unanswered: EvePageUnanswered[]
    }
  | { ok: true; application: null; fields: number; values: []; documents: []; unanswered: [] }
  | { ok: false; error: string }
