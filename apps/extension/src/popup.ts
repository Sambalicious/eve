/**
 * The popup: connect an Eve origin, review what Eve would type, then watch the
 * background fill it (ADR 0016).
 *
 * The popup no longer owns a fill. It renders `fillRun` from
 * `chrome.storage.session` and re-renders whenever that record changes, so a
 * popup that closes mid-run loses nothing and reopening shows the live run.
 */
import { eveOriginOf } from "./origin.js"
import { isSensitiveLabel, maskedValue } from "./review.js"

/** A stored `filling` run older than this has lost its worker: the popup says so. */
const STALE_MS = 60_000
/** The live region announces at most one change per this long, except a terminal one. */
const ANNOUNCE_MS = 2_000
/** A Stop that replaces the Fill button ignores a click for this long: the second half of that click. Time only, no visual state. */
const ARM_MS = 500
/** An item line names the field in progress, cut short. A value never appears in it. */
const MAX_ITEM_LABEL = 40

void (() => {
  const ORIGIN_KEY = "eveOrigin"
  const RUN_KEY = "fillRun"
  const TERMINAL: ReadonlySet<EveFillRunStatus> = new Set(["done", "stopped", "failed"])

  type Tone = "muted" | "success" | "warning" | "destructive"
  type Icon = "info" | "spinner" | "check" | "alert" | "stop" | "x"

  /** One line under a result headline: a quiet icon, then words. */
  interface Row {
    icon: Icon
    text: string
  }

  /** The plan on screen. It lives only in this popup's memory, as before. */
  interface ReviewedPlan {
    application: EveFillApplication
    values: EveFillPlanValue[]
    documents: EveFillPlanDocument[]
    unanswered: EvePageUnanswered[]
  }

  type View =
    | { kind: "idle" }
    | { kind: "planning" }
    | { kind: "review" }
    | { kind: "notice" }
    | { kind: "active"; run: EveFillRun }
    | { kind: "other-tab"; run: EveFillRun }
    | { kind: "terminal"; run: EveFillRun }
    | { kind: "interrupted"; run: EveFillRun }

  function element<T extends HTMLElement | SVGElement>(id: string): T {
    const found = document.getElementById(id)
    if (found === null) throw new Error(`missing #${id}`)
    return found as T
  }

  const connectionText = element<HTMLSpanElement>("connection-text")
  const changeButton = element<HTMLButtonElement>("change")
  /** The separator and Change, wrapped together so a long address never strands either. */
  const connectionTail = element<HTMLSpanElement>("connection-tail")
  const addressBlock = element<HTMLElement>("address-block")
  const address = element<HTMLInputElement>("origin")
  const connectButton = element<HTMLButtonElement>("connect")
  const actions = element<HTMLElement>("actions")
  const reviewButton = element<HTMLButtonElement>("fill")
  const applyButton = element<HTMLButtonElement>("apply")
  const stopButton = element<HTMLButtonElement>("stop")
  const bar = element<HTMLElement>("bar")
  const status = element<HTMLElement>("status")
  const statusText = element<HTMLParagraphElement>("status-text")
  const statusSub = element<HTMLParagraphElement>("status-sub")
  const statusIcon = element<SVGSVGElement>("status-icon")
  const statusIconUse = statusIcon.querySelector("use")
  const resultLines = element<HTMLUListElement>("result-lines")
  const progressBlock = element<HTMLElement>("progress-block")
  const progressText = element<HTMLParagraphElement>("progress-text")
  const progress = element<HTMLProgressElement>("progress")
  const reviewSection = element<HTMLElement>("review")
  const reviewSummary = element<HTMLParagraphElement>("review-summary")
  const reviewValues = element<HTMLUListElement>("review-values")
  const uploadNote = element<HTMLParagraphElement>("upload-note")
  const pageNote = element<HTMLParagraphElement>("page-note")
  const limits = element<HTMLParagraphElement>("limits")
  const announceNode = element<HTMLParagraphElement>("announce")

  /** The saved Eve origin, or null when the extension is not connected. */
  let connected: string | null = null
  /** True while the Candidate is editing the saved address: the block is open, Cancel closes it. */
  let editing = false
  /** The review on screen, if any. FILL_APPLY carries exactly its refs. */
  let plan: ReviewedPlan | null = null
  /** True between the FILL_APPLY click and the run record it creates. */
  let planning = false
  /** One sentence that is not a run: a connection result, a review refusal. */
  let notice: { text: string; tone: "info" | "error" } | null = null
  /** The stored run. The popup is a view of this record and of nothing else. */
  let run: EveFillRun | null = null
  let activeTabId: number | null = null

  /** Set synchronously before an await, so two clicks in one tick send one FILL_APPLY. */
  let busy = false
  /** Set once a start is claimed, so the next Stop-able view takes focus. */
  let pendingStopFocus = false

  /** Which Stop is on screen, so a switch between tabs resets its arming. */
  let stopMode: "tab" | "other" | null = null
  let stopAccepted = false
  let stopArmedUntil = 0
  let repeatedKey = false

  let seenRunId: string | null = null
  let staleStopSent: string | null = null
  /** The last words written to the live region, so a repaint of the same words is not a new announcement. */
  let announcedText = ""
  let lastAnnounceAt = 0
  let renderedKind: View["kind"] = "idle"

  function send<T>(message: EveExtensionRequest): Promise<T | undefined> {
    try {
      return (chrome.runtime.sendMessage(message) as Promise<unknown>).then(
        (answer: unknown) => answer as T | undefined,
        () => undefined
      )
    } catch {
      return Promise.resolve(undefined)
    }
  }

  /** `company · role`, or "" when Eve matched neither. Used where the line stands alone. */
  function applicationLine(application: EveFillApplication): string {
    return [application.company, application.roleTitle].filter((part): part is string => part !== null && part !== "").join(" · ")
  }

  function matchedName(application: EveFillApplication): string {
    const line = applicationLine(application)
    return line === "" ? "Matched your Eve application" : `Matched ${line}`
  }

  /** What the review says a document field will receive. The file's name is unknown until it is downloaded. */
  function documentSentence(documentKind: EveDocumentKind): string {
    return documentKind === "resume" ? "will attach the prepared resume PDF" : "will attach the prepared cover letter PDF"
  }

  /** One sentence for a document that stayed unattached. `document` comes from the record, so a reopen still names it. */
  function documentFailureLine(failure: EveDocumentFailure): string {
    const name = failure.document === "resume" ? "Resume" : "Cover letter"
    if (failure.reason === "signed_out") return `${name} was not attached: sign in to Eve and try again.`
    if (failure.reason === "not_available") return `${name} was not attached: Eve has no prepared PDF for it.`
    if (failure.reason === "too_large") return `${name} was not attached: the file is too large.`
    return `${name} was not attached. Attach it yourself.`
  }

  /**
   * One review row: the page's own label, the value, and for a sensitive one a
   * Show/Hide button. The real value is not in the DOM until Show is pressed,
   * and a re-render (Review again) puts the mask back.
   */
  function reviewRow(value: EveFillPlanValue): HTMLLIElement {
    const row = document.createElement("li")
    const label = document.createElement("span")
    label.className = "review-label"
    const labelText = value.label === "" ? value.ref : value.label
    label.textContent = labelText
    const shown = document.createElement("span")
    shown.className = "review-value"
    const sensitive = isSensitiveLabel(value.label)
    shown.textContent = sensitive ? maskedValue(value.value) : value.value
    row.append(label, shown)
    if (sensitive) {
      const mark = document.createElement("span")
      mark.className = "sensitive"
      mark.textContent = "sensitive"
      label.append(mark)
      // The dots are decoration; a screen reader hears the button, not a row of bullets.
      shown.setAttribute("aria-hidden", "true")
      const reveal = document.createElement("button")
      reveal.type = "button"
      reveal.className = "btn-reveal"
      reveal.textContent = "Show"
      reveal.setAttribute("aria-label", `Show value for ${labelText}`)
      reveal.addEventListener("click", () => {
        const show = reveal.textContent === "Show"
        shown.textContent = show ? value.value : maskedValue(value.value)
        if (show) shown.removeAttribute("aria-hidden")
        else shown.setAttribute("aria-hidden", "true")
        reveal.textContent = show ? "Hide" : "Show"
        reveal.setAttribute("aria-label", `${show ? "Hide" : "Show"} value for ${labelText}`)
      })
      row.append(reveal)
    }
    return row
  }

  /** One document row: the page field that asked for it and which prepared PDF will go there. */
  function reviewDocumentRow(planned: EveFillPlanDocument): HTMLLIElement {
    const row = document.createElement("li")
    const label = document.createElement("span")
    label.className = "review-label"
    label.textContent = planned.label === "" ? planned.ref : planned.label
    const shown = document.createElement("span")
    shown.className = "review-value"
    shown.textContent = documentSentence(planned.document)
    row.append(label, shown)
    return row
  }

  /** One required field Eve has no approved answer for: a row like the others, saying so. */
  function unansweredRow(entry: EvePageUnanswered): HTMLLIElement {
    const row = document.createElement("li")
    const label = document.createElement("span")
    label.className = "review-label"
    label.textContent = entry.label === "" ? entry.ref : entry.label
    const shown = document.createElement("span")
    shown.className = "review-value"
    shown.textContent = "No approved answer"
    row.append(label, shown)
    return row
  }

  function approvedRefs(): string[] {
    if (plan === null) return []
    // An older background build, or a plan kept alive across a stale service worker, can arrive without these arrays.
    const values = plan.values ?? []
    const documents = plan.documents ?? []
    return [...values.map((value) => value.ref), ...documents.map((document) => document.ref)]
  }

  /** The item line: the run's item, nothing else. A field value never goes here. */
  function itemLine(current: EveFillRunCurrent): string {
    if (current.kind === "resume") return "Attaching: Resume"
    if (current.kind === "cover_letter") return "Attaching: Cover letter"
    const raw = current.label.trim()
    const label = raw === "" ? "a field" : raw.length > MAX_ITEM_LABEL ? `${raw.slice(0, MAX_ITEM_LABEL)}…` : raw
    return `Filling: ${label}`
  }

  /** The counter under the status: progress already made, never the item in flight. */
  function counterLine(active: EveFillRun): string {
    return `${active.completed} of ${active.total} done`
  }

  /** Another tab's run, named by the application when Eve matched one. */
  function otherTabLine(elsewhere: EveFillRun): string {
    if (elsewhere.status === "stopping") return "Stopping the fill in another tab…"
    const line = applicationLine(elsewhere.application)
    return line === "" ? "Filling your Eve application in another tab." : `Filling ${line} in another tab.`
  }

  /** The headline and rows a finished run leaves behind. N counts everything that needs the Candidate. */
  function resultOf(finished: EveFillRun): { headline: string; rows: Row[] } {
    const summary = finished.summary
    const rows: Row[] = []
    if (summary === null) return { headline: `Filled ${finished.completed} of ${finished.total}.`, rows }
    const needs = summary.unanswered + summary.mismatched.length + summary.failures.length
    const headline =
      `Filled ${summary.filled + summary.attached} of ${finished.total}.` +
      (needs === 0 ? "" : needs === 1 ? " 1 thing needs you." : ` ${needs} things need you.`)
    if (summary.unanswered > 0) {
      rows.push({
        icon: "alert",
        text:
          summary.unanswered === 1
            ? "1 required field has no approved answer. It is outlined on the page."
            : `${summary.unanswered} required fields have no approved answer. They are outlined on the page.`,
      })
    }
    if (summary.mismatched.length > 0) {
      rows.push({
        icon: "alert",
        text:
          summary.mismatched.length === 1
            ? "1 field did not keep the value Eve set. Check it."
            : `${summary.mismatched.length} fields did not keep the value Eve set. Check them.`,
      })
    }
    for (const failure of summary.failures) rows.push({ icon: "alert", text: documentFailureLine(failure) })
    return { headline, rows }
  }

  function stoppedCopy(stopped: EveFillRun): { headline: string; rows: Row[] } {
    if (stopped.completed === 0) return { headline: "Stopped before anything was filled. Nothing was submitted.", rows: [] }
    const rows: Row[] = [{ icon: "stop", text: "What was filled stays on the page." }]
    if ((stopped.summary?.attached ?? 0) > 0) rows.push({ icon: "stop", text: "Attached documents stay on the page; remove them there if you do not want them sent." })
    return { headline: `Stopped after ${stopped.completed} of ${stopped.total}. Nothing was submitted.`, rows }
  }

  function interruptedCopy(interrupted: EveFillRun): string {
    return `Filling was interrupted after ${interrupted.completed} of ${interrupted.total}. Nothing was submitted. Check the page, then fill again.`
  }

  /** A `filling` run whose heartbeat stopped: its worker is gone. */
  function isStale(candidate: EveFillRun): boolean {
    return candidate.status === "filling" && Date.now() - candidate.updatedAt > STALE_MS
  }

  function isActive(candidate: EveFillRun): boolean {
    return candidate.status === "filling" || candidate.status === "stopping"
  }

  function resolveView(): View {
    if (run !== null && isActive(run)) {
      // A run belongs to one tab. Another tab's live run is shown, never driven.
      if (run.tabId !== activeTabId) return { kind: "other-tab", run }
      if (run.status === "stopping") return { kind: "active", run }
      if (isStale(run)) return { kind: "interrupted", run }
      return { kind: "active", run }
    }
    if (run !== null && TERMINAL.has(run.status)) {
      // A result for another tab is not this page's result.
      if (run.tabId !== activeTabId) return notice !== null ? { kind: "notice" } : { kind: "idle" }
      return { kind: "terminal", run }
    }
    if (planning) return { kind: "planning" }
    if (plan !== null) return { kind: "review" }
    if (notice !== null) return { kind: "notice" }
    return { kind: "idle" }
  }

  /** Paint the panel. The visible text updates on every render; `announce` decides what is heard. */
  function paintStatus(text: string, icon: Icon, tone: Tone, sub: string | null): void {
    status.hidden = false
    statusText.textContent = text
    statusSub.hidden = sub === null
    statusSub.textContent = sub ?? ""
    statusIconUse?.setAttribute("href", `#i-${icon}`)
    statusIcon.classList.toggle("is-success", tone === "success")
    statusIcon.classList.toggle("is-warning", tone === "warning")
    statusIcon.classList.toggle("is-destructive", tone === "destructive")
    statusIcon.classList.toggle("spinner", icon === "spinner")
  }

  /**
   * The live region. `immediate` is for everything that is not an item in
   * flight: a review, a refusal, a terminal state, the first item of a run and
   * every document step. The rest is throttled, so seven fast fields cannot
   * talk over each other.
   */
  function announce(text: string, immediate: boolean): void {
    if (text === "" || text === announcedText) return
    const now = Date.now()
    if (!immediate && now - lastAnnounceAt < ANNOUNCE_MS) return
    announcedText = text
    lastAnnounceAt = now
    announceNode.textContent = text
  }

  function rowOf(row: Row): HTMLLIElement {
    const item = document.createElement("li")
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    icon.setAttribute("class", "row-icon")
    icon.setAttribute("aria-hidden", "true")
    icon.setAttribute("focusable", "false")
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use")
    use.setAttribute("href", `#i-${row.icon}`)
    icon.append(use)
    const text = document.createElement("span")
    text.textContent = row.text
    item.append(icon, text)
    return item
  }

  function paintRows(rows: Row[]): void {
    if (rows.length === 0) {
      resultLines.hidden = true
      resultLines.replaceChildren()
      return
    }
    resultLines.hidden = false
    resultLines.replaceChildren(...rows.map(rowOf))
  }

  function hideStatus(): void {
    status.hidden = true
    statusText.textContent = ""
    statusSub.hidden = true
    statusSub.textContent = ""
    statusIcon.classList.remove("is-success", "is-warning", "is-destructive", "spinner")
    paintRows([])
  }

  function paintProgress(active: EveFillRun | null): void {
    if (active === null) {
      progressBlock.hidden = true
      progressText.textContent = ""
      progress.value = 0
      progress.max = 1
      return
    }
    progressBlock.hidden = false
    progress.max = Math.max(active.total, 1)
    progress.value = Math.min(active.completed, active.total)
    progressText.textContent = counterLine(active)
  }

  function paintFill(label: string, disabled: boolean, primary: boolean): void {
    reviewButton.textContent = label
    reviewButton.disabled = disabled
    reviewButton.classList.toggle("btn-primary", primary)
    reviewButton.classList.toggle("btn-outline", !primary)
  }

  function paintConnect(primary: boolean): void {
    connectButton.classList.toggle("btn-primary", primary)
    connectButton.classList.toggle("btn-outline", !primary)
  }

  /**
   * The connection sentence. A saved origin gets a <wbr> after "//" and after each dot, so when it
   * is longer than the line it breaks at a dot, not mid-label. Text nodes only, never innerHTML:
   * the origin is the Candidate's own input.
   */
  function paintConnectionText(): void {
    if (connected === null) {
      connectionText.textContent = "Not connected to Eve."
      return
    }
    const nodes: Node[] = [document.createTextNode("Connected to ")]
    const pieces = connected.split(/(?<=\/\/|\.)/)
    pieces.forEach((piece, index) => {
      if (index > 0) nodes.push(document.createElement("wbr"))
      nodes.push(document.createTextNode(piece))
    })
    connectionText.replaceChildren(...nodes)
  }

  /** The line, the address block and the one filled button, for the view on screen. */
  function paintConnection(kind: View["kind"]): void {
    const running = kind === "active" || kind === "other-tab"
    const canChange = !running && connected !== null
    paintConnectionText()
    // An unsaved or absent address is always open; a saved one collapses until Change.
    addressBlock.hidden = running || (connected !== null && !editing)
    // The dot only separates the address from a Change the Candidate can press.
    connectionTail.hidden = !canChange
    changeButton.hidden = !canChange
    changeButton.textContent = editing ? "Cancel" : "Change"
    actions.hidden = running
    paintConnect(connected === null || editing)
  }

  /** The review is only a second choice while the address is being edited. */
  function reviewPrimary(): boolean {
    return connected !== null && !editing
  }

  function showStopBar(stopping: boolean, otherTab: boolean): void {
    bar.hidden = false
    applyButton.hidden = true
    stopButton.hidden = false
    const mode = otherTab ? "other" : "tab"
    if (stopMode !== mode) {
      stopMode = mode
      stopAccepted = false
      stopButton.removeAttribute("aria-disabled")
      stopArmedUntil = 0
      if (otherTab) {
        stopButton.textContent = "Stop the other tab's fill"
        stopButton.setAttribute("aria-label", "Stop the other tab's fill")
      } else {
        stopButton.textContent = "Stop"
        stopButton.setAttribute("aria-label", "Stop filling")
        // Only a Stop that replaces the Fill button the Candidate just pressed arms: that
        // click's second half must not stop the fill. The arming is a time check inside
        // onStopClick and nothing else: Stop looks and is announced as active from the
        // first frame (no aria-disabled, no dimming), so the Candidate is never shown a
        // control that is "off" while a fill is running.
        if (pendingStopFocus) {
          stopArmedUntil = Date.now() + ARM_MS
          pendingStopFocus = false
          stopButton.focus()
        }
      }
    }
    if (stopping) {
      stopAccepted = true
      stopButton.setAttribute("aria-disabled", "true")
      if (!otherTab) stopButton.textContent = "Stopping…"
    }
  }

  function hideStopBar(): void {
    stopButton.hidden = true
    if (stopMode !== null) {
      stopMode = null
      stopAccepted = false
      stopButton.textContent = "Stop"
      stopButton.setAttribute("aria-label", "Stop filling")
      stopButton.removeAttribute("aria-disabled")
    }
  }

  function hideBar(): void {
    hideStopBar()
    applyButton.hidden = true
    bar.hidden = true
  }

  function showApplyBar(label: string, enabled: boolean): void {
    hideStopBar()
    bar.hidden = false
    applyButton.hidden = false
    applyButton.textContent = label
    applyButton.disabled = !enabled
  }

  function renderReview(): void {
    if (plan === null) return
    // Tolerate a plan whose arrays are missing: a missing array reads as an empty one, never as a thrown render.
    const values = plan.values ?? []
    const documents = plan.documents ?? []
    const unanswered = plan.unanswered ?? []
    const planned: string[] = []
    if (values.length === 1) planned.push("1 value will be typed")
    else if (values.length > 1) planned.push(`${values.length} values will be typed`)
    if (documents.length === 1) planned.push("1 document will be attached")
    else if (documents.length > 1) planned.push(`${documents.length} documents will be attached`)
    const summary = `${matchedName(plan.application)}. ${planned.length === 0 ? "Nothing will be typed." : `${planned.join(" and ")}; review each one.`}`
    reviewSummary.textContent =
      unanswered.length > 0 ? `${summary} Fields with no approved answer are left empty and outlined on the page.` : summary
    reviewValues.replaceChildren(...values.map(reviewRow), ...documents.map(reviewDocumentRow), ...unanswered.map(unansweredRow))
    // A file leaves this browser the moment the employer's form accepts it; say so only when one will be attached.
    uploadNote.hidden = documents.length === 0
    pageNote.hidden = false
  }

  function render(): void {
    const view = resolveView()
    const previousKind = renderedKind
    renderedKind = view.kind

    paintConnection(view.kind)
    // The limits paragraph explains what a fill will and will not do: it belongs with a decision, not a progress line.
    limits.hidden = view.kind === "planning" || view.kind === "active" || view.kind === "other-tab" || view.kind === "interrupted" || view.kind === "terminal"

    switch (view.kind) {
      case "idle": {
        hideStatus()
        paintProgress(null)
        hideBar()
        reviewSection.hidden = true
        paintFill("Review values", connected === null, reviewPrimary())
        break
      }
      case "planning": {
        paintStatus("Reading this page and asking Eve…", "spinner", "muted", null)
        announce("Reading this page and asking Eve…", true)
        paintProgress(null)
        hideBar()
        reviewSection.hidden = true
        paintFill("Review values", true, false)
        break
      }
      case "review": {
        const ready = approvedRefs().length > 0
        renderReview()
        reviewSection.hidden = false
        paintProgress(null)
        paintFill("Review again", false, false)
        if (ready && plan !== null) {
          const label = (plan.documents ?? []).length === 0 ? `Fill these values (${(plan.values ?? []).length})` : `Fill these values and documents (${approvedRefs().length})`
          showApplyBar(label, !busy)
          const sentence = `Check the list, then press "${label}". Nothing has been filled yet.`
          paintStatus(sentence, "info", "muted", null)
          announce(sentence, true)
        } else {
          hideBar()
          const sentence = "Eve has no values for this form. Answer the outlined fields on the page."
          paintStatus(sentence, "info", "muted", null)
          announce(sentence, true)
        }
        break
      }
      case "notice": {
        paintProgress(null)
        hideBar()
        reviewSection.hidden = true
        paintStatus(notice?.text ?? "", notice?.tone === "error" ? "x" : "info", notice?.tone === "error" ? "destructive" : "muted", null)
        announce(notice?.text ?? "", true)
        paintFill("Review values", connected === null, reviewPrimary())
        break
      }
      case "active": {
        const active = view.run
        const stopping = active.status === "stopping"
        reviewSection.hidden = true
        paintProgress(active)
        showStopBar(stopping, false)
        paintFill("Review values", true, false)
        const firstOfRun = seenRunId !== active.id
        seenRunId = active.id
        if (stopping) {
          paintStatus("Stopping…", "spinner", "muted", null)
          announce("Stopping…", true)
          break
        }
        if (active.current === null) {
          paintStatus("Filling the values you reviewed…", "spinner", "muted", null)
          announce("Filling the values you reviewed…", true)
          break
        }
        const line = itemLine(active.current)
        paintStatus(line, "spinner", "muted", null)
        const itemNumber = active.current.index + 1
        // First of a run, a document step and every fifth item may be announced; the rest only move the counter.
        const documentStep = active.current.kind !== "value"
        if (firstOfRun || documentStep || itemNumber % 5 === 0) announce(line, firstOfRun || documentStep)
        break
      }
      case "other-tab": {
        const elsewhere = view.run
        const stopping = elsewhere.status === "stopping"
        reviewSection.hidden = true
        paintProgress(elsewhere)
        showStopBar(stopping, true)
        paintFill("Review values", true, false)
        const line = otherTabLine(elsewhere)
        paintStatus(line, "info", "muted", null)
        announce(line, true)
        seenRunId = elsewhere.id
        break
      }
      case "interrupted": {
        const stale = view.run
        reviewSection.hidden = true
        paintProgress(null)
        hideBar()
        paintFill("Review values", false, reviewPrimary())
        const sentence = interruptedCopy(stale)
        paintStatus(sentence, "x", "destructive", null)
        announce(sentence, true)
        // One FILL_STOP lets a worker that is still there settle the record; a dead one ignores it.
        if (staleStopSent !== stale.id) {
          staleStopSent = stale.id
          void send({ type: "FILL_STOP" })
        }
        break
      }
      case "terminal": {
        const finished = view.run
        reviewSection.hidden = true
        paintProgress(null)
        hideBar()
        paintFill("Review values", false, reviewPrimary())
        const sub = applicationLine(finished.application) === "" ? null : applicationLine(finished.application)
        if (finished.status === "failed") {
          const sentence = finished.error ?? "The fill stopped unexpectedly. Nothing was submitted."
          paintStatus(sentence, "x", "destructive", sub)
          announce(sentence, true)
          break
        }
        if (finished.status === "stopped") {
          const copy = stoppedCopy(finished)
          paintStatus(copy.headline, "stop", "muted", sub)
          paintRows(copy.rows)
          announce(copy.headline, true)
          break
        }
        const result = resultOf(finished)
        paintStatus(result.headline, result.rows.length > 0 ? "alert" : "check", result.rows.length > 0 ? "warning" : "success", sub)
        paintRows(result.rows)
        announce(result.headline, true)
        break
      }
    }

    // A finished run hands the keyboard back to the button that starts the next one.
    if (view.kind === "terminal" && (previousKind === "active" || previousKind === "other-tab" || previousKind === "interrupted")) reviewButton.focus()
  }

  /** Reads the saved origin, the active tab and the stored run, then paints once. */
  async function start(): Promise<void> {
    // Register first: a change between the read and the listener would otherwise be lost.
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "session" || changes[RUN_KEY] === undefined) return
      const next = (changes[RUN_KEY].newValue as EveFillRun | undefined) ?? null
      if (next !== null && run !== null && next.id === run.id && next.updatedAt < run.updatedAt) return
      run = next
      render()
    })

    const stored = await chrome.storage.local.get(ORIGIN_KEY)
    const origin = stored[ORIGIN_KEY]
    connected = typeof origin === "string" && origin !== "" ? origin : null
    if (connected !== null) address.value = connected

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    activeTabId = tab?.id ?? null

    const session = await chrome.storage.session.get(RUN_KEY)
    run = (session[RUN_KEY] as EveFillRun | undefined) ?? null
    render()
  }

  async function connectEve(): Promise<void> {
    const parsed = eveOriginOf(address.value)
    if (!parsed.ok) {
      notice = {
        text:
          parsed.reason === "insecure"
            ? "Use an https:// address. Plain http:// is allowed only for localhost or 127.0.0.1."
            : "Enter your Eve address, like https://eve.example.com.",
        tone: "error",
      }
      render()
      return
    }
    // Must run inside the click's gesture: nothing is awaited before it.
    const granted = await chrome.permissions.request({ origins: [`${parsed.origin}/*`] })
    if (!granted) {
      notice = { text: "Chrome did not allow access to that address.", tone: "error" }
      render()
      return
    }
    await chrome.storage.local.set({ [ORIGIN_KEY]: parsed.origin })
    connected = parsed.origin
    editing = false
    notice = null
    render()
    // The line above already says it; this is for a screen reader that was not looking.
    announce("Eve is connected.", true)
  }

  /** Step 1: read the page and show every label and value that a fill would type. Nothing is typed yet. */
  async function planFill(): Promise<void> {
    if (planning) return
    planning = true
    plan = null
    notice = null
    render()
    const summary = await send<EveFillPlanSummary>({ type: "FILL_PLAN" })
    planning = false
    if (summary === undefined) {
      notice = { text: "Eve did not answer. Nothing was submitted.", tone: "error" }
      render()
      return
    }
    if (!summary.ok) {
      notice = { text: summary.error, tone: "error" }
      render()
      return
    }
    if (summary.application === null) {
      notice = { text: "This page is not an Eve application. Nothing was filled.", tone: "error" }
      render()
      return
    }
    plan = {
      application: summary.application,
      values: summary.values ?? [],
      documents: summary.documents ?? [],
      unanswered: summary.unanswered ?? [],
    }
    render()
  }

  /** Step 2: fill exactly the refs the Candidate just reviewed. One click, one start. */
  async function applyFill(): Promise<void> {
    if (busy || plan === null) return
    const refs = approvedRefs()
    if (refs.length === 0) return
    // Synchronous, before the first await: a second click in the same tick is a no-op.
    busy = true
    applyButton.disabled = true
    reviewButton.disabled = true
    const ack = await send<EveFillApplyAck>({ type: "FILL_APPLY", refs })
    busy = false
    if (ack === undefined) {
      plan = null
      notice = { text: "Eve did not answer. Nothing was submitted.", tone: "error" }
      render()
      return
    }
    if (!ack.ok) {
      // The live run is still the truth; an "already running" ack is not an error to show.
      if (ack.error === "A fill is already running.") {
        render()
        return
      }
      plan = null
      notice = { text: ack.error, tone: "error" }
      render()
      return
    }
    // The review is spent: from here the run record is the only thing on screen.
    plan = null
    pendingStopFocus = true
    const session = await chrome.storage.session.get(RUN_KEY)
    run = (session[RUN_KEY] as EveFillRun | undefined) ?? null
    render()
  }

  function onStopClick(event: MouseEvent): void {
    // The second click of a double click, a click inside the arming window, and a held key are all one choice.
    if (event.detail > 1) return
    if (event.detail === 0 && repeatedKey) return
    if (Date.now() < stopArmedUntil) return
    if (stopAccepted) return
    stopAccepted = true
    // The other tab's fill keeps its own words: Stop there is not this tab's Stop.
    if (stopMode === "tab") stopButton.textContent = "Stopping…"
    stopButton.setAttribute("aria-disabled", "true")
    void send({ type: "FILL_STOP" })
  }

  stopButton.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return
    // A held key is one choice, not one per repeat.
    if (event.repeat) {
      repeatedKey = true
      event.preventDefault()
    }
  })
  stopButton.addEventListener("keyup", () => {
    repeatedKey = false
  })
  stopButton.addEventListener("click", onStopClick)

  changeButton.addEventListener("click", () => {
    if (connected === null) return
    editing = !editing
    address.value = connected
    render()
    if (editing) address.focus()
  })

  connectButton.addEventListener("click", () => {
    void connectEve()
  })
  reviewButton.addEventListener("click", () => {
    void planFill()
  })
  applyButton.addEventListener("click", () => {
    void applyFill()
  })

  void start()
})()
