/**
 * The MV3 service worker (ADR 0016). Three messages from the popup:
 *
 *  1. FILL_PLAN reads the form in the active employer tab (injected
 *     `dist/page.js`), asks Eve for the values through the bridge in the
 *     Candidate's own Eve tab (`dist/eve-bridge.js`), and returns the plan with
 *     the page's label for every ref. It types nothing.
 *  2. FILL_APPLY carries the refs the Candidate approved in the popup. The
 *     worker claims the start, answers at once, and then steps the page one
 *     item at a time: `begin`, one `fillValue` per approved value, one download
 *     and one `attachFile` per approved document, then `finish`. It writes the
 *     run to `chrome.storage.session` under `fillRun` after every item, so the
 *     popup is only a view of it and a closed popup loses nothing.
 *  3. FILL_STOP stops the run wherever it is. A value already being set finishes
 *     and counts; a download in flight is abandoned and its bytes dropped.
 *     Nothing is submitted, ever.
 *
 * The plan lives in `chrome.storage.session` between the two clicks, keyed to
 * the tab and URL it was read from, so a service-worker restart loses nothing
 * and a page that changed in between is refused rather than filled. It stores
 * nothing else but the Eve origin, keeps no answer beyond the one plan, and
 * never clicks Submit or a link. It may click a checkbox or radio to set it the
 * way the Candidate would. A classic script with no imports; the wrapped body
 * keeps its names out of the global scope.
 */
void (() => {
  const PAGE_SCRIPT = "dist/page.js"
  const BRIDGE_SCRIPT = "dist/eve-bridge.js"
  const ORIGIN_KEY = "eveOrigin"
  const PLAN_KEY = "fillPlan"
  const RUN_KEY = "fillRun"
  const LOAD_TIMEOUT_MS = 20_000
  /** Each phase of a review has its own bound, so the popup can say which one stopped answering. */
  const PAGE_READ_TIMEOUT_MS = 10_000
  const EVE_TAB_TIMEOUT_MS = 15_000
  const BRIDGE_FILL_TIMEOUT_MS = 20_000
  /** A ceiling over the whole review: no path may leave the popup reading the same line forever. */
  const PLAN_TIMEOUT_MS = 30_000
  const PAGE_READ_TIMEOUT_COPY = "This page did not respond. Reload it and try again. Nothing was filled."
  const EVE_TAB_TIMEOUT_COPY = "Eve did not respond. Open Eve in this browser, then try again."
  const BRIDGE_FILL_TIMEOUT_COPY = "Eve did not answer in time. Nothing was filled. Try again."
  const PLAN_TIMEOUT_COPY = "Reviewing took too long. Nothing was filled. Try again."
  const MAX_PAGE_URL = 2048
  const REF_PATTERN = /^[fr]\d{1,4}$/
  /** While a run steps, its `updatedAt` is refreshed this often, so the popup can tell a live run from a dead one. */
  const HEARTBEAT_MS = 20_000
  /** A run that has not finished in this long is failed rather than left to hang. */
  const MAX_RUN_MS = 5 * 60_000
  const POPUP_URL = chrome.runtime.getURL("src/popup.html")

  const TERMINAL: ReadonlySet<EveFillRunStatus> = new Set(["done", "stopped", "failed"])

  /** A start is claimed synchronously, before the first `await`, so two same-tick messages cannot both start a run. */
  let starting = false
  /** The run this worker is stepping. A persisted record with no id here has no loop behind it. */
  let activeRun: string | null = null
  /** Every run write is chained: a step never overwrites a newer run and never writes after a terminal status. */
  let writes: Promise<unknown> = Promise.resolve()
  /** A blocked download is released by FILL_STOP or by a terminal write, so Stop never waits for bytes. */
  let stopSignal: { runId: string; release: () => void } | null = null

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse): boolean | undefined => {
    // Only this extension's popup may ask for a fill: same extension id, no tab, and the popup's own URL.
    // A content script carries its tab and the page's URL, both of which are refused here.
    if (sender.id !== chrome.runtime.id || sender.tab !== undefined || sender.url !== POPUP_URL) return undefined
    if (!isExtensionRequest(message)) return undefined
    const answer = message.type === "FILL_PLAN" ? planFill() : message.type === "FILL_STOP" ? stopFill() : applyFill(message.refs)
    answer.then(sendResponse, (error: unknown) => sendResponse({ ok: false, error: failure(error) }))
    // Keeps the message channel open for the asynchronous answer.
    return true
  })

  function isExtensionRequest(message: unknown): message is EveExtensionRequest {
    if (typeof message !== "object" || message === null) return false
    const type = (message as { type?: unknown }).type
    return type === "FILL_PLAN" || type === "FILL_APPLY" || type === "FILL_STOP"
  }

  function failure(error: unknown): string {
    const text = error instanceof Error ? error.message : ""
    return text === "" ? "The fill stopped unexpectedly. Nothing was submitted." : text
  }

  /**
   * Bounds one phase of a review. The timer is cleared on either settle, and an
   * answer that arrives after the timeout is dropped rather than acted on.
   */
  function withTimeout<T>(work: Promise<T>, ms: number, errorText: string, onTimeout?: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (): boolean => {
        if (settled) return false
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        return true
      }
      timer = setTimeout(() => {
        if (!finish()) return
        onTimeout?.()
        reject(new Error(errorText))
      }, ms)
      work.then(
        (value) => {
          if (finish()) resolve(value)
        },
        (error: unknown) => {
          if (finish()) reject(error)
        }
      )
    })
  }

  function webUrl(raw: string): URL | null {
    try {
      const url = new URL(raw)
      return url.protocol === "https:" || url.protocol === "http:" ? url : null
    } catch {
      return null
    }
  }

  async function eveOrigin(): Promise<string | null> {
    const stored = await chrome.storage.local.get(ORIGIN_KEY)
    const origin = stored[ORIGIN_KEY]
    return typeof origin === "string" && origin !== "" ? origin : null
  }

  /** Runs a function in a tab's isolated world and returns what it answered (a promise is awaited). */
  async function runInTab<T>(tabId: number, func: (...args: unknown[]) => unknown, args: unknown[] = []): Promise<T | null> {
    const injection = { target: { tabId }, func, args } as unknown as chrome.scripting.ScriptInjection<unknown[], unknown>
    const [first] = await chrome.scripting.executeScript(injection)
    const value = await first?.result
    return (value as T | undefined) ?? null
  }

  /**
   * The page as the API matches it: origin, path and query, never credentials
   * and never the fragment. A query that would exceed the cap is dropped.
   */
  function pageUrlForRequest(page: URL): string {
    const clean = new URL(page.toString())
    clean.username = ""
    clean.password = ""
    clean.hash = ""
    const base = `${clean.origin}${clean.pathname}`
    const withSearch = `${base}${clean.search}`
    return withSearch.length <= MAX_PAGE_URL ? withSearch : base
  }

  /** The request form of a stored tab URL, or null when it is not a web URL. */
  function requestUrlOf(raw: string): string | null {
    const parsed = webUrl(raw)
    return parsed === null ? null : pageUrlForRequest(parsed)
  }

  /** The Candidate's open Eve tab, or a new inactive one, loaded and ready for the bridge. `"sign_in"` means the tab left Eve's origin. */
  async function eveTab(origin: string): Promise<number | "sign_in" | null> {
    let open: chrome.tabs.Tab | undefined
    try {
      const found = await chrome.tabs.query({ url: `${origin}/*` })
      // A discarded tab has no page to inject into; prefer one that is still live.
      open = found.find((tab) => tab.id !== undefined && tab.discarded !== true) ?? found[0]
    } catch {
      open = undefined
    }
    if (open?.id !== undefined) {
      await waitForLoad(open.id)
      return open.id
    }
    const created = await chrome.tabs.create({ url: origin, active: false })
    if (created.id === undefined) return null
    await waitForLoad(created.id)
    const settled = await chrome.tabs.get(created.id).catch(() => null)
    // A fresh tab that lands on a sign-in page (or elsewhere) has no Eve session to use.
    if (settled !== null && typeof settled.url === "string" && !sameOrigin(settled.url, origin)) return "sign_in"
    return created.id
  }

  function sameOrigin(raw: string, origin: string): boolean {
    try {
      return new URL(raw).origin === origin
    } catch {
      return false
    }
  }

  /** Resolves when the tab reports `complete`, or after the timeout (a slow Eve page still answers the fetch). */
  function waitForLoad(tabId: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
      const listener = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
        if (id === tabId && info.status === "complete") finish()
      }
      chrome.tabs.onUpdated.addListener(listener)
      timer = setTimeout(finish, LOAD_TIMEOUT_MS)
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete") finish()
      }, finish)
    })
  }

  /** The bridge's failure as a sentence the Candidate can act on. */
  function bridgeFailure(bridge: Extract<EveBridgeResult, { ok: false }>): string {
    if (bridge.error === "unauthorized" || bridge.status === 401) return "Sign in to Eve in this browser, then try again."
    if (bridge.status === 403) return "Eve refused this request. Nothing was filled."
    if (bridge.status === 429) return "Eve is receiving too many fills. Wait a minute, then try again."
    if (bridge.error === "network") return "Eve could not be reached. Nothing was filled."
    if (bridge.error === "session") return "Eve's session could not be read. Sign in to Eve, then try again."
    if (bridge.error === "csrf") return "Eve refused this request. Reload Eve, then try again."
    return `Eve answered ${bridge.status}. Nothing was filled.`
  }

  /** The active employer tab and its request URL, or a sentence saying why it cannot be read. */
  async function activePage(): Promise<{ tabId: number; url: string } | { error: string }> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id === undefined || typeof tab.url !== "string") return { error: "This page can't be filled." }
    const page = webUrl(tab.url)
    if (page === null) return { error: "This page can't be filled." }
    return { tabId: tab.id, url: pageUrlForRequest(page) }
  }

  /** The Candidate's Eve tab, injected with the bridge, or a sentence saying why it cannot be used. */
  async function bridgeTab(): Promise<{ tabId: number } | { error: string }> {
    const origin = await eveOrigin()
    if (origin === null) return { error: "Connect Eve first." }
    const allowed = await chrome.permissions.contains({ origins: [`${origin}/*`] })
    if (!allowed) return { error: "Reconnect Eve to allow access to its address." }
    const tabId = await eveTab(origin)
    if (tabId === "sign_in") return { error: "Sign in to Eve in this browser, then try again." }
    if (tabId === null) return { error: "Open Eve in this browser, then try again." }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE_SCRIPT] })
    } catch {
      return { error: "Eve's tab could not be read. Reload it, then try again." }
    }
    return { tabId }
  }

  /** The document failure as the one reason the popup needs. No byte crosses this mapping. */
  function documentFailureReason(result: Extract<EveBridgeDownloadResult, { ok: false }>): EveDocumentFailureReason {
    if (result.error === "unauthorized" || result.status === 401) return "signed_out"
    if (result.error === "not_available" || result.status === 404) return "not_available"
    if (result.error === "too_large") return "too_large"
    return "unattached"
  }

  /** Inject the page reader and read the form, as one phase the review can bound. */
  async function readPageFields(tabId: number): Promise<EvePageField[]> {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [PAGE_SCRIPT] })
    } catch {
      throw new Error("This page can't be filled. Try an application form in a normal tab.")
    }
    return (await runInTab<EvePageField[]>(tabId, () => (globalThis as unknown as { __evePage: EvePageApi }).__evePage.read())) ?? []
  }

  /** Ask Eve what it would type. This is the only step that reads the page; it never fills. */
  async function planFill(): Promise<EveFillPlanSummary> {
    let abandoned = false
    try {
      return await withTimeout(
        planFillOnce(() => abandoned),
        PLAN_TIMEOUT_MS,
        PLAN_TIMEOUT_COPY,
        () => {
          abandoned = true
        }
      )
    } catch (error) {
      return { ok: false, error: failure(error) }
    }
  }

  async function planFillOnce(abandoned: () => boolean): Promise<EveFillPlanSummary> {
    const expired = (): EveFillPlanSummary | null => (abandoned() ? { ok: false, error: PLAN_TIMEOUT_COPY } : null)
    // A review while a run is stepping would compete with it for the page.
    const running = await readRun()
    if (running !== null && (running.status === "filling" || running.status === "stopping")) return { ok: false, error: "A fill is already running." }
    // A plan from an earlier popup must not survive a new review: clear it before anything can fail.
    await chrome.storage.session.remove(PLAN_KEY)
    const origin = await eveOrigin()
    if (origin === null) return { ok: false, error: "Connect Eve first." }
    const active = await activePage()
    if ("error" in active) return { ok: false, error: active.error }

    const pageExpired = expired()
    if (pageExpired !== null) return pageExpired
    let fields: EvePageField[]
    try {
      fields = await withTimeout(readPageFields(active.tabId), PAGE_READ_TIMEOUT_MS, PAGE_READ_TIMEOUT_COPY)
    } catch (error) {
      return { ok: false, error: failure(error) }
    }
    if (fields.length === 0) return { ok: false, error: "No form fields found on this page." }

    const eveExpired = expired()
    if (eveExpired !== null) return eveExpired
    let eve: { tabId: number } | { error: string }
    try {
      eve = await withTimeout(bridgeTab(), EVE_TAB_TIMEOUT_MS, EVE_TAB_TIMEOUT_COPY)
    } catch (error) {
      return { ok: false, error: failure(error) }
    }
    if ("error" in eve) return { ok: false, error: eve.error }

    const bridgeExpired = expired()
    if (bridgeExpired !== null) return bridgeExpired
    let bridge: EveBridgeResult | null
    try {
      bridge = await withTimeout(
        runInTab<EveBridgeResult>(eve.tabId, (body: unknown) => (globalThis as unknown as { __eveBridge: EveBridgeApi }).__eveBridge.fill(body as EveFillBody), [
          { url: active.url, fields },
        ]),
        BRIDGE_FILL_TIMEOUT_MS,
        BRIDGE_FILL_TIMEOUT_COPY
      )
    } catch (error) {
      return { ok: false, error: failure(error) }
    }
    if (bridge === null) return { ok: false, error: "Eve did not answer. Nothing was filled." }
    if (!bridge.ok) return { ok: false, error: bridgeFailure(bridge) }

    const plan = bridge.body
    if (plan.application === null) return { ok: true, application: null, fields: fields.length, values: [], documents: [], unanswered: [] }
    // The background read the fields, so it can put the page's label next to every ref Eve answered.
    const labelOf = new Map(fields.map((field) => [field.ref, field.label]))
    const values: EveFillPlanValue[] = plan.values
      .filter((value) => labelOf.has(value.ref))
      .map((value) => ({ ref: value.ref, label: labelOf.get(value.ref) ?? "", value: value.value, kind: value.kind }))
    const documents: EveFillPlanDocument[] = (Array.isArray(plan.documents) ? plan.documents : [])
      .filter((document) => labelOf.has(document.ref))
      .map((document) => ({ ref: document.ref, label: labelOf.get(document.ref) ?? "", document: document.document }))
    const unanswered = Array.isArray(plan.unanswered) ? plan.unanswered : []
    const storedExpired = expired()
    if (storedExpired !== null) return storedExpired
    const stored: EveStoredFillPlan = { tabId: active.tabId, url: active.url, fields: fields.length, application: plan.application, values, documents, unanswered }
    await chrome.storage.session.set({ [PLAN_KEY]: stored })
    return { ok: true, application: plan.application, fields: fields.length, values, documents, unanswered }
  }

  async function storedPlan(): Promise<EveStoredFillPlan | null> {
    const stored = await chrome.storage.session.get(PLAN_KEY)
    const plan = stored[PLAN_KEY] as EveStoredFillPlan | undefined
    return plan === undefined ? null : plan
  }

  async function readRun(): Promise<EveFillRun | null> {
    const stored = await chrome.storage.session.get(RUN_KEY)
    const run = stored[RUN_KEY] as EveFillRun | undefined
    return run === undefined ? null : run
  }

  /**
   * One run write, in dependency order behind every earlier one. A write for a
   * different run is dropped (a newer run is never clobbered), a write after a
   * terminal status is dropped (the result is final), and `stopping` never
   * moves back to `filling`. Every write stamps `updatedAt`.
   */
  function writeRun(id: string, patch: Partial<EveFillRun>): Promise<EveFillRun | null> {
    const write = writes.then(async (): Promise<EveFillRun | null> => {
      const current = await readRun()
      if (current === null || current.id !== id) return null
      if (TERMINAL.has(current.status)) return current
      if (current.status === "stopping" && patch.status === "filling") return current
      const next: EveFillRun = { ...current, ...patch, updatedAt: Date.now() }
      await chrome.storage.session.set({ [RUN_KEY]: next })
      return next
    })
    writes = write.then(
      () => undefined,
      () => undefined
    )
    return write
  }

  /** The one promise a blocked download waits on beside its bytes: Stop or a terminal write releases it. */
  function stopSignalFor(runId: string): Promise<void> {
    return new Promise((release) => {
      stopSignal = { runId, release }
    })
  }

  function releaseStop(runId: string): void {
    if (stopSignal !== null && stopSignal.runId === runId) {
      const { release } = stopSignal
      stopSignal = null
      release()
    }
  }

  function pageChangedCopy(completed: number, total: number): string {
    return completed === 0
      ? "The page changed while you reviewed. Nothing was filled; review again."
      : `The page changed while filling. Stopped after ${completed} of ${total}. Nothing was submitted.`
  }

  function interruptedCopy(completed: number, total: number): string {
    return `Filling was interrupted after ${completed} of ${total}. Nothing was submitted. Check the page, then fill again.`
  }

  function timeoutCopy(completed: number, total: number): string {
    return `The fill took too long and was stopped after ${completed} of ${total}. Nothing was submitted.`
  }

  const TAB_CLOSED_COPY = "The tab was closed while filling. Nothing was submitted."

  /**
   * Claim the start and answer at once. The stepper runs on its own: the popup
   * may close mid-run, and reopening reads the record it is writing.
   */
  async function applyFill(rawRefs: unknown): Promise<EveFillApplyAck> {
    if (starting) return { ok: false, error: "A fill is already running." }
    starting = true
    try {
      const running = await readRun()
      if (running !== null && (running.status === "filling" || running.status === "stopping")) return { ok: false, error: "A fill is already running." }
      const plan = await storedPlan()
      if (plan === null) return { ok: false, error: "The review expired. Review the values again." }
      // A plan is one-shot: it goes at the start, so a second click cannot reuse the review.
      await chrome.storage.session.remove(PLAN_KEY)
      // The tab must still be the page the Candidate reviewed: a new page is never filled from an old plan.
      const tab = await chrome.tabs.get(plan.tabId).catch(() => null)
      if (tab === null || typeof tab.url !== "string" || requestUrlOf(tab.url) !== plan.url) {
        return { ok: false, error: "The page changed. Review the values again." }
      }
      const approved = new Set(
        (Array.isArray(rawRefs) ? rawRefs : []).filter((ref): ref is string => typeof ref === "string" && REF_PATTERN.test(ref))
      )
      const values = plan.values.filter((value) => approved.has(value.ref))
      // Only a document the Candidate reviewed and approved is ever downloaded.
      const documents = plan.documents.filter((document) => approved.has(document.ref))
      if (values.length === 0 && documents.length === 0) return { ok: false, error: "No reviewed values were approved. Nothing was filled." }

      const now = Date.now()
      const run: EveFillRun = {
        id: crypto.randomUUID(),
        status: "filling",
        tabId: plan.tabId,
        url: plan.url,
        application: plan.application,
        total: values.length + documents.length,
        completed: 0,
        current: null,
        summary: null,
        error: null,
        startedAt: now,
        updatedAt: now,
      }
      await chrome.storage.session.set({ [RUN_KEY]: run })
      activeRun = run.id
      // Not awaited: the ack is the promise, the stepping is the worker's.
      void step(run.id, plan, values, documents)
      return { ok: true, runId: run.id }
    } catch (error) {
      return { ok: false, error: failure(error) }
    } finally {
      starting = false
    }
  }

  /**
   * Step the page one item at a time, writing the record after every item.
   * Values go first, so a Stop at any later point leaves them on the page; a
   * document's download is followed directly by its attach.
   */
  async function step(id: string, plan: EveStoredFillPlan, values: EveFillPlanValue[], documents: EveFillPlanDocument[]): Promise<void> {
    const total = values.length + documents.length
    const startedAt = Date.now()
    let completed = 0
    let filled = 0
    let attached = 0
    let unanswered = 0
    const mismatched: string[] = []
    const failures: EveDocumentFailure[] = []
    let closed = false
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let finished = false
    let bridge: { tabId: number } | { error: string } | null = null
    const stopped = stopSignalFor(id)

    const summaryOf = (): EveFillRunSummary => ({
      fields: plan.fields,
      filled,
      documents: documents.length,
      attached,
      unanswered,
      mismatched: [...mismatched],
      failures: [...failures],
    })

    const stopBeat = () => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat)
        heartbeat = undefined
      }
    }

    /** The terminal write. It happens once, it always carries the counts, and nothing follows it. */
    const close = async (status: EveFillRunStatus, error: string | null): Promise<void> => {
      if (closed) return
      closed = true
      stopBeat()
      await writeRun(id, { status, completed, current: null, summary: summaryOf(), error })
      // A reopened popup reads the record, so the plan beside it is spent either way.
      await chrome.storage.session.remove(PLAN_KEY)
      releaseStop(id)
    }

    /** `finish()` runs once, on the normal path and on a Stop that ends between two items. */
    const callFinish = async (): Promise<void> => {
      if (finished) return
      finished = true
      try {
        const result = await runInTab<EvePageFinishResult>(plan.tabId, () => (globalThis as unknown as { __evePage: EvePageApi }).__evePage.finish())
        unanswered = result?.unanswered ?? 0
      } catch {
        // A page that went away has nothing left to outline; the run's own copy already says so.
      }
    }

    /**
     * Before every item: has the Candidate stopped, is the page still the one
     * the plan was read from, and is the run still inside its cap?
     */
    const beforeItem = async (): Promise<boolean> => {
      if (closed) return false
      const run = await readRun()
      if (run === null || run.id !== id || TERMINAL.has(run.status)) {
        closed = true
        stopBeat()
        return false
      }
      if (run.status === "stopping") {
        // A Stop that ends between two items still outlines what is left, once.
        await callFinish()
        await close("stopped", null)
        return false
      }
      if (Date.now() - startedAt >= MAX_RUN_MS) {
        await close("failed", timeoutCopy(completed, total))
        return false
      }
      const tab = await chrome.tabs.get(run.tabId).catch(() => null)
      if (tab === null) {
        await close("failed", TAB_CLOSED_COPY)
        return false
      }
      if (typeof tab.url !== "string" || requestUrlOf(tab.url) !== run.url) {
        // A different page gets no further item, and no finish(): its fields are not the reviewed ones.
        await close("failed", pageChangedCopy(completed, total))
        return false
      }
      return true
    }

    heartbeat = setInterval(() => {
      void (async () => {
        if (closed) return
        if (Date.now() - startedAt >= MAX_RUN_MS) {
          await close("failed", timeoutCopy(completed, total))
          return
        }
        await writeRun(id, {})
      })()
    }, HEARTBEAT_MS)

    try {
      // Arm the page for this run: a previous run's outlines go before the first item.
      try {
        await runInTab(plan.tabId, () => (globalThis as unknown as { __evePage: EvePageApi }).__evePage.begin())
      } catch {
        await close("failed", TAB_CLOSED_COPY)
        return
      }

      for (let index = 0; index < values.length; index++) {
        const value = values[index]!
        if (!(await beforeItem())) return
        // The plan's own label: the item line never reads a label back off the page.
        await writeRun(id, { completed, current: { index, kind: "value", label: value.label } })
        let kept: boolean
        try {
          kept =
            (await runInTab<boolean>(
              plan.tabId,
              (item: unknown) => (globalThis as unknown as { __evePage: EvePageApi }).__evePage.fillValue(item as EvePageValue),
              [{ ref: value.ref, value: value.value, kind: value.kind }]
            )) === true
        } catch {
          await close("failed", TAB_CLOSED_COPY)
          return
        }
        if (kept) filled++
        else mismatched.push(value.ref)
        completed++
      }

      for (let index = 0; index < documents.length; index++) {
        const planned = documents[index]!
        if (!(await beforeItem())) return
        await writeRun(id, { completed, current: { index: values.length + index, kind: planned.document, label: planned.label } })
        // The bridge is injected once per run, not once per document.
        if (bridge === null) bridge = await bridgeTab()
        if ("error" in bridge) {
          failures.push({ ref: planned.ref, document: planned.document, reason: "unattached" })
          completed++
          continue
        }
        // A failed or unreachable download is recorded and the run goes on; the next item still runs.
        const download = runInTab<EveBridgeDownloadResult>(
          bridge.tabId,
          (applicationId: unknown, kind: unknown) =>
            (globalThis as unknown as { __eveBridge: EveBridgeApi }).__eveBridge.download(applicationId as string, kind as EveDocumentKind),
          [plan.application.id, planned.document]
        ).catch(() => null)
        // Stop abandons the bytes: the answer is dropped unread, and the page never sees it.
        const settled = await Promise.race([
          download.then((value) => ({ downloaded: true as const, value })),
          stopped.then(() => ({ downloaded: false as const, value: null })),
        ])
        const after = await readRun()
        if (after === null || after.id !== id || TERMINAL.has(after.status)) {
          closed = true
          stopBeat()
          return
        }
        if (after.status === "stopping") {
          await close("stopped", null)
          return
        }
        if (!settled.downloaded || settled.value === null) {
          failures.push({ ref: planned.ref, document: planned.document, reason: "unattached" })
          completed++
          continue
        }
        const result = settled.value
        if (!result.ok) {
          failures.push({ ref: planned.ref, document: planned.document, reason: documentFailureReason(result) })
          completed++
          continue
        }
        let landed: boolean
        try {
          landed =
            (await runInTab<boolean>(
              plan.tabId,
              (document: unknown) => (globalThis as unknown as { __evePage: EvePageApi }).__evePage.attachFile(document as EvePageDocument),
              [{ ref: planned.ref, name: result.name, type: result.type, base64: result.base64 }]
            )) === true
        } catch {
          await close("failed", TAB_CLOSED_COPY)
          return
        }
        if (landed) attached++
        else mismatched.push(planned.ref)
        completed++
      }

      if (!(await beforeItem())) return
      await callFinish()
      await close("done", null)
    } finally {
      closed = true
      stopBeat()
      releaseStop(id)
      if (activeRun === id) activeRun = null
    }
  }

  /** Stop the run wherever it is. Idempotent, and it always answers. */
  async function stopFill(): Promise<{ ok: true }> {
    const run = await readRun()
    if (run === null) return { ok: true }
    if (run.status === "filling") {
      if (activeRun === run.id) {
        await writeRun(run.id, { status: "stopping" })
        // The stepper settles the record; this only ends its wait if a download is in flight.
        releaseStop(run.id)
      } else {
        // A record from a worker that is gone: nothing steps it again, so it is finalised here.
        await writeRun(run.id, { status: "failed", completed: run.completed, current: null, summary: run.summary, error: interruptedCopy(run.completed, run.total) })
        await chrome.storage.session.remove(PLAN_KEY)
      }
      return { ok: true }
    }
    return { ok: true }
  }

  /**
   * A worker start can inherit a run whose loop died with the previous worker.
   * It is failed as interrupted, once, for its own id only.
   */
  async function reconcile(): Promise<void> {
    const run = await readRun()
    if (run === null) return
    if (run.status !== "filling" && run.status !== "stopping") return
    if (activeRun === run.id) return
    await writeRun(run.id, { status: "failed", completed: run.completed, current: null, summary: run.summary, error: interruptedCopy(run.completed, run.total) })
    await chrome.storage.session.remove(PLAN_KEY)
  }

  void reconcile()
})()
