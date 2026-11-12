import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

import type { StoredDocument } from "../stored-document.js"

import { BrowserUnavailableError, type EvidenceStage, type FormControl, type FormRead, type FormSession, type FormSessionFactory, OffOriginError, type PageAfterSubmit } from "../form-session.js"
import type { LabelCheck } from "../answer-assignment.js"
import { OPEN_GUARD, READ_FORM, READ_HOST, READ_RESULT, SUBMIT_SELECTOR, refSelector } from "./form-scripts.js"
import { type McpCaller, evaluateResult } from "./mcp-caller.js"

export { OffOriginError }

export type PlaywrightFormSessionsOptions = Readonly<{
  /** One MCP connection per attempt (ADR 0008). */
  connect: (attemptId: string) => Promise<McpCaller>
  /** Worker-side upload directory, a volume the browser mounts read-only. */
  uploadDir: string
  /** The same directory as the browser container sees it (inside its file-access root). */
  uploadDirInBrowser: string
  /** The egress proxy's allowlist file; the worker writes it before each attempt. */
  allowlistFile: string
  /** Reviewed extra hosts per application host (static assets, upload storage, reCAPTCHA). */
  reviewedHosts: Readonly<Record<string, readonly string[]>>
  /** Upper bound for waiting on confirmation after the click. */
  resultWaitSeconds: number
}>

type RawForm = {
  host: string
  text: string
  controls: FormControl[]
  values: Record<string, string>
  submitControls: number
  guard: number
}

/**
 * The Playwright MCP FormSession (ADR 0008, architecture r1 journey 2 steps 2,
 * 3, 6, 9, 10, 11). Backend code only: fixed scripts, backend-chosen selectors
 * and backend values. After every call that can change the page it checks the
 * top-level host and throws `OffOriginError` on any other host. `clickSubmit`
 * runs at most once per session and is never retried.
 */
export class PlaywrightFormSessions implements FormSessionFactory {
  constructor(private readonly options: PlaywrightFormSessionsOptions) {}

  async create(attemptId: string): Promise<FormSession> {
    let mcp: McpCaller
    try {
      mcp = await this.options.connect(attemptId)
    } catch {
      throw new BrowserUnavailableError()
    }
    return new PlaywrightFormSession(mcp, attemptId, this.options)
  }
}

class PlaywrightFormSession implements FormSession {
  private applicationHost: string | null = null
  private controls = new Map<string, FormControl>()
  private clicked = false

  constructor(
    private readonly mcp: McpCaller,
    private readonly attemptId: string,
    private readonly options: PlaywrightFormSessionsOptions
  ) {}

  private get uploadDir(): string {
    return join(this.options.uploadDir, this.attemptId)
  }

  async open(applyUrl: string): Promise<FormRead> {
    const host = new URL(applyUrl).host
    this.applicationHost = host
    const hostname = new URL(applyUrl).hostname
    // SEC-503: the file names its owner on a comment line; only that attempt clears it.
    await writeFile(this.options.allowlistFile, [this.allowlistOwner, hostname, ...(this.options.reviewedHosts[hostname] ?? [])].join("\n") + "\n", { mode: 0o644 })
    await this.mcp.call("browser_navigate", { url: applyUrl })
    await this.checkHost()
    return toFormRead(await this.readRaw())
  }

  async fill(ref: string, value: string): Promise<void> {
    const control = this.control(ref)
    const target = refSelector(ref)
    switch (control.kind) {
      case "text":
      case "textarea":
        await this.mcp.call("browser_fill_form", { fields: [{ target, name: control.label, type: "textbox", value }] })
        break
      case "checkbox":
        await this.mcp.call("browser_fill_form", { fields: [{ target, name: control.label, type: "checkbox", value: value === "true" ? "true" : "false" }] })
        break
      case "select":
        await this.mcp.call("browser_select_option", { target, element: control.label, values: [value] })
        break
      case "radio":
        await this.mcp.call("browser_click", { target: `${target}[data-ja-option=${JSON.stringify(value)}]`, element: control.label })
        break
      case "file":
        throw new Error("A file input is filled with attach")
    }
    await this.checkHost()
  }

  async attach(ref: string, document: StoredDocument): Promise<void> {
    const control = this.control(ref)
    if (control.kind !== "file") throw new Error("Not a file input")
    const name = document.name
    if (basename(name) !== name || name.startsWith(".")) throw new Error("Invalid document name")
    // F-SEC-03: the bytes come through CandidateFiles.read (O_NOFOLLOW, real directories), never copyFile on a path.
    const bytes = await document.read()
    await mkdir(this.uploadDir, { recursive: true, mode: 0o755 })
    // The same document may go to two fields: rm unlinks an earlier copy (never a link target), then wx writes fresh.
    const target = join(this.uploadDir, name)
    await rm(target, { force: true })
    await writeFile(target, bytes, { flag: "wx", mode: 0o644 })
    // Clicking a file input opens the chooser modal; browser_file_upload answers it.
    await this.mcp.call("browser_click", { target: refSelector(ref), element: control.label })
    await this.mcp.call("browser_file_upload", { paths: [`${this.options.uploadDirInBrowser}/${this.attemptId}/${name}`] })
    await this.checkHost()
  }

  async readValues(): Promise<Readonly<{ form: FormRead; values: Readonly<Record<string, string>> }>> {
    const raw = await this.readRaw()
    return { form: toFormRead(raw), values: { ...raw.values } }
  }

  async clickSubmit(): Promise<void> {
    if (this.clicked) throw new Error("The submit control was already clicked in this attempt")
    this.clicked = true
    const opened = evaluateResult(await this.mcp.call("browser_evaluate", { function: OPEN_GUARD }))
    if (opened !== true) throw new Error("The submit guard did not open")
    // The one click. No loop, no retry: an error here may still have reached the employer.
    await this.mcp.call("browser_click", { target: SUBMIT_SELECTOR, element: "Submit application" })
  }

  async waitForResult(settled: (page: PageAfterSubmit) => boolean): Promise<PageAfterSubmit> {
    let page: PageAfterSubmit = UNREADABLE_RESULT
    for (let second = 0; second < this.options.resultWaitSeconds; second += 1) {
      page = await this.readResult()
      if (settled(page)) break
      if (second < this.options.resultWaitSeconds - 1) await this.mcp.call("browser_wait_for", { time: 1 }).catch(() => undefined)
    }
    return page
  }

  async saveEvidence(stage: EvidenceStage): Promise<readonly string[]> {
    const snapshot = `${this.attemptId}-${stage}.yml`
    const screenshot = `${this.attemptId}-${stage}.png`
    await this.mcp.call("browser_snapshot", { filename: snapshot })
    await this.mcp.call("browser_take_screenshot", { filename: screenshot })
    return [snapshot, screenshot]
  }

  async close(): Promise<void> {
    await this.mcp.call("browser_close", {}).catch(() => undefined)
    await this.mcp.close().catch(() => undefined)
    await rm(this.uploadDir, { recursive: true, force: true })
    await this.clearOwnAllowlist().catch(() => undefined)
  }

  private get allowlistOwner(): string {
    return `# attempt ${this.attemptId}`
  }

  /** Empties the allowlist only if this attempt still owns it; another attempt's hosts are never removed. */
  private async clearOwnAllowlist(): Promise<void> {
    const current = await readFile(this.options.allowlistFile, "utf8").catch(() => "")
    if (current.split("\n", 1)[0] === this.allowlistOwner) await writeFile(this.options.allowlistFile, "", { mode: 0o644 })
  }

  private control(ref: string): FormControl {
    const control = this.controls.get(ref)
    if (!control) throw new Error("Unknown form ref")
    return control
  }

  private async checkHost(): Promise<void> {
    const host = evaluateResult(await this.mcp.call("browser_evaluate", { function: READ_HOST }))
    if (host !== this.applicationHost) throw new OffOriginError(typeof host === "string" ? host : "")
  }

  private async readResult(): Promise<PageAfterSubmit> {
    try {
      return parseResult(evaluateResult(await this.mcp.call("browser_evaluate", { function: READ_RESULT })))
    } catch {
      return UNREADABLE_RESULT
    }
  }

  private async readRaw(): Promise<RawForm> {
    const raw = parseRawForm(evaluateResult(await this.mcp.call("browser_evaluate", { function: READ_FORM })))
    if (raw.host !== this.applicationHost) throw new OffOriginError(raw.host)
    this.controls = new Map(raw.controls.map((control) => [control.ref, control]))
    return raw
  }
}

function toFormRead(raw: RawForm): FormRead {
  // A missing guard (-1) counts as tripped: no guard, no submit.
  return { host: raw.host, text: raw.text, controls: raw.controls, submitControls: raw.submitControls, guardTripped: raw.guard !== 0 }
}

/** Nothing readable after the click: no host, so never evidence. */
const UNREADABLE_RESULT: PageAfterSubmit = { host: "", text: "", formPresent: false, validationErrors: false }

/** The page wrote this object; a field of the wrong type reads as the safe value (form present, errors shown). */
function parseResult(value: unknown): PageAfterSubmit {
  if (typeof value !== "object" || value === null) return UNREADABLE_RESULT
  const record = value as Record<string, unknown>
  return {
    host: typeof record.host === "string" ? record.host : "",
    text: typeof record.text === "string" ? record.text : "",
    formPresent: record.formPresent !== false,
    validationErrors: record.validationErrors !== false,
  }
}

const KINDS = new Set(["text", "textarea", "select", "radio", "checkbox", "file"])

/** The page wrote this object; every field is checked before backend code trusts its shape. */
function parseRawForm(value: unknown): RawForm {
  if (typeof value !== "object" || value === null) throw new Error("Unreadable form")
  const record = value as Record<string, unknown>
  const controls = Array.isArray(record.controls) ? record.controls : []
  const values = typeof record.values === "object" && record.values !== null ? (record.values as Record<string, unknown>) : {}
  return {
    host: typeof record.host === "string" ? record.host : "",
    text: typeof record.text === "string" ? record.text : "",
    controls: controls.flatMap((item): FormControl[] => {
      if (typeof item !== "object" || item === null) return []
      const control = item as Record<string, unknown>
      if (typeof control.ref !== "string" || !/^[fr]\d{1,4}$/.test(control.ref) || typeof control.kind !== "string" || !KINDS.has(control.kind)) return []
      const options = Array.isArray(control.options) ? control.options.filter((option): option is string => typeof option === "string") : undefined
      return [
        {
          ref: control.ref,
          label: typeof control.label === "string" ? control.label.slice(0, 500) : "",
          kind: control.kind as FormControl["kind"],
          required: control.required === true,
          ...(options ? { options } : {}),
          ...(control.combobox === true ? { combobox: true } : {}),
          ...parseLabelCheck(control.labelCheck),
          // Identity only; a schemaQuestion the page wrote is never read.
          ...(typeof control.fieldName === "string" ? { fieldName: control.fieldName.slice(0, 200) } : {}),
          ...(typeof control.fieldId === "string" ? { fieldId: control.fieldId.slice(0, 200) } : {}),
        },
      ]
    }),
    values: Object.fromEntries(Object.entries(values).map(([key, item]) => [key, typeof item === "string" ? item : ""])),
    submitControls: typeof record.submitControls === "number" ? record.submitControls : 0,
    guard: typeof record.guard === "number" ? record.guard : -1,
  }
}

/**
 * SEC-513: the page wrote the label check too. A malformed check is kept as a
 * flag so a work question blocks rather than losing the check.
 */
function parseLabelCheck(value: unknown): { labelCheck?: LabelCheck } {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null) return { labelCheck: { readings: [], flags: ["malformed"] } }
  const record = value as Record<string, unknown>
  const strings = (items: unknown) => (Array.isArray(items) ? items.filter((item): item is string => typeof item === "string").map((item) => item.slice(0, 500)).slice(0, 20) : null)
  const readings = strings(record.readings)
  const flags = strings(record.flags)
  if (readings === null || flags === null) return { labelCheck: { readings: readings ?? [], flags: [...(flags ?? []), "malformed"] } }
  return { labelCheck: { readings, flags } }
}
