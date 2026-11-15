// @ts-expect-error -- Vite serves the popup's markup as raw text in the test.
import popupHtml from "./popup.html?raw"

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The popup renders from the real `popup.html` body, so a row, a note or a
 * button the markup does not have is caught here rather than in the browser.
 * The run arrives the way the worker delivers it: from `storage.session` on
 * open, and through `storage.onChanged` afterwards.
 */
function popupBody(): string {
  const match = /<body>([\s\S]*)<\/body>/i.exec(popupHtml)
  if (match === null) throw new Error("popup.html has no body")
  return match[1]!
}

const APPLICATION = { id: "6f1c2a4e-0000-4000-8000-000000000001", company: "Acme Payments", roleTitle: "Senior Frontend Engineer" }
const ACTIVE_TAB = 7

const PLAN_WITH_DOCUMENTS: EveFillPlanSummary = {
  ok: true,
  application: APPLICATION,
  fields: 2,
  values: [{ ref: "f0", label: "First name", value: "Ada", kind: "text" }],
  documents: [{ ref: "f1", label: "Resume", document: "resume" }],
  unanswered: [],
}

const PLAN_WITHOUT_DOCUMENTS: EveFillPlanSummary = {
  ok: true,
  application: APPLICATION,
  fields: 1,
  values: [{ ref: "f0", label: "First name", value: "Ada", kind: "text" }],
  documents: [],
  unanswered: [],
}

const PLAN_EMPTY: EveFillPlanSummary = { ok: true, application: APPLICATION, fields: 3, values: [], documents: [], unanswered: [] }

/** What an older background build, or a stale service worker, sends: the array fields are absent. */
const PLAN_FROM_OLDER_BACKGROUND = {
  ok: true,
  application: APPLICATION,
  fields: 1,
  values: [{ ref: "f0", label: "First name", value: "Ada", kind: "text" }],
} as unknown as EveFillPlanSummary

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>
type ChangeListener = (changes: Changes, areaName: string) => void

interface StubOptions {
  origin?: string | null
  plan?: EveFillPlanSummary | (() => Promise<EveFillPlanSummary>)
  ack?: EveFillApplyAck
  /** The record the worker writes when a start is claimed. */
  appliedRun?: EveFillRun
  run?: EveFillRun | null
  activeTabId?: number | null
  stopAnswer?: () => Promise<unknown>
}

function aRun(overrides: Partial<EveFillRun> = {}): EveFillRun {
  return {
    id: "run-1",
    status: "filling",
    tabId: ACTIVE_TAB,
    url: "https://employer.example/apply",
    application: APPLICATION,
    total: 7,
    completed: 2,
    current: { index: 2, kind: "value", label: "First name" },
    summary: null,
    error: null,
    startedAt: 1,
    updatedAt: Date.now(),
    ...overrides,
  }
}

function summary(overrides: Partial<EveFillRunSummary> = {}): EveFillRunSummary {
  return { fields: 3, filled: 3, documents: 0, attached: 0, unanswered: 0, mismatched: [], failures: [], ...overrides }
}

function stubChrome(options: StubOptions = {}) {
  const sent: EveExtensionRequest[] = []
  const listeners: ChangeListener[] = []
  const state = {
    origin: options.origin === undefined ? "https://eve.example.com" : options.origin,
    run: options.run ?? null,
    permission: true,
  }

  const stub = {
    runtime: {
      sendMessage: vi.fn(async (message: EveExtensionRequest) => {
        sent.push(message)
        if (message.type === "FILL_PLAN") {
          return typeof options.plan === "function" ? options.plan() : (options.plan ?? PLAN_WITH_DOCUMENTS)
        }
        if (message.type === "FILL_APPLY") {
          const ack = options.ack ?? { ok: true, runId: "run-1" }
          if (ack.ok && options.appliedRun !== undefined) state.run = { ...options.appliedRun }
          return ack
        }
        return options.stopAnswer === undefined ? { ok: true } : options.stopAnswer()
      }),
    },
    storage: {
      local: {
        get: vi.fn(async () => (state.origin === null ? {} : { eveOrigin: state.origin })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          if (typeof items.eveOrigin === "string") state.origin = items.eveOrigin
        }),
      },
      session: { get: vi.fn(async (key: string) => (key === "fillRun" && state.run !== null ? { fillRun: state.run } : {})) },
      onChanged: { addListener: (fn: ChangeListener) => listeners.push(fn) },
    },
    tabs: { query: vi.fn(async () => (options.activeTabId === null ? [] : [{ id: options.activeTabId ?? ACTIVE_TAB }])) },
    permissions: { request: vi.fn(async () => state.permission) },
  }

  return {
    stub,
    sent,
    state,
    /** Delivers a `fillRun` change the way `chrome.storage.onChanged` does. */
    fire: (run: EveFillRun | null) => {
      state.run = run
      for (const listener of listeners) listener({ fillRun: { oldValue: undefined, newValue: run } }, "session")
    },
  }
}

type Harness = ReturnType<typeof stubChrome>

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function open(options: StubOptions = {}): Promise<Harness> {
  const harness = stubChrome(options)
  document.body.innerHTML = popupBody()
  ;(globalThis as unknown as { chrome: typeof chrome }).chrome = harness.stub as unknown as typeof chrome
  vi.resetModules()
  await import("./popup.js")
  await flush()
  await flush()
  return harness
}

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id)
  if (found === null) throw new Error(`missing #${id}`)
  return found as T
}

const statusText = (): string => element("status-text").textContent ?? ""
const statusSub = (): string => element("status-sub").textContent ?? ""
const announced = (): string => element("announce").textContent ?? ""
const connectionText = (): string => element("connection-text").textContent ?? ""
const resultLines = (): string[] => [...document.querySelectorAll("#result-lines li")].map((line) => line.textContent ?? "")
const progressText = (): string => element("progress-text").textContent ?? ""
const progress = (): HTMLProgressElement => element("progress") as HTMLProgressElement
const stopButton = (): HTMLButtonElement => element("stop")
const applyButton = (): HTMLButtonElement => element("apply")
const fillButton = (): HTMLButtonElement => element("fill")
const changeButton = (): HTMLButtonElement => element("change")
const reviewRows = (): HTMLElement[] => [...document.querySelectorAll("#review-values li")] as HTMLElement[]

/** An element is visible when neither it nor an ancestor carries `hidden`. */
function visible(target: Element): boolean {
  for (let node: Element | null = target; node !== null; node = node.parentElement) {
    if (node instanceof HTMLElement && node.hidden) return false
  }
  return true
}

const primaries = (): Element[] => [...document.querySelectorAll(".btn-primary")].filter((node) => visible(node))

/** Review the page, which is the only way a plan reaches the popup. */
async function review(): Promise<void> {
  fillButton().click()
  await flush()
  await flush()
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  delete (globalThis as unknown as { chrome?: typeof chrome }).chrome
  vi.restoreAllMocks()
})

describe("the popup's review (ADR 0016: the page label next to the prepared PDF)", () => {
  it("renders one row per planned document without throwing", async () => {
    await open()
    await review()

    expect(reviewRows()).toHaveLength(2)
    const rows = reviewRows().map((row) => row.textContent ?? "")
    expect(rows[1]).toContain("Resume")
    expect(rows[1]).toContain("will attach the prepared resume PDF")
  })

  it("renders a plan whose documents and unanswered arrays are missing", async () => {
    // A stale service worker can answer with the summary an older background build sent.
    await open({ plan: PLAN_FROM_OLDER_BACKGROUND })
    await review()

    expect(statusText()).toBe('Check the list, then press "Fill these values (1)". Nothing has been filled yet.')
    expect(applyButton().textContent).toBe("Fill these values (1)")
    expect(applyButton().disabled).toBe(false)
    expect(element("upload-note").hidden).toBe(true)
    expect(reviewRows()).toHaveLength(1)
    expect(reviewRows()[0]?.querySelector(".review-label")?.textContent).toBe("First name")
  })

  it("still renders document rows when the background sends documents", async () => {
    await open({ plan: PLAN_WITH_DOCUMENTS })
    await review()

    expect(reviewRows()).toHaveLength(2)
    expect(reviewRows()[1]?.querySelector(".review-label")?.textContent).toBe("Resume")
    expect(reviewRows()[1]?.querySelector(".review-value")?.textContent).toContain("will attach the prepared resume PDF")
    expect(element("upload-note").hidden).toBe(false)
    expect(applyButton().textContent).toBe("Fill these values and documents (2)")
  })

  it("approves every reviewed ref, the document refs included", async () => {
    const { sent } = await open()
    await review()

    expect(applyButton().disabled).toBe(false)
    expect(applyButton().textContent).toBe("Fill these values and documents (2)")

    applyButton().click()
    await flush()
    expect(sent.filter((message) => message.type === "FILL_APPLY")).toEqual([{ type: "FILL_APPLY", refs: ["f0", "f1"] }])
  })

  it("shows the upload note above the list, and only when the plan has documents", async () => {
    await open()
    await review()
    const note = element("upload-note")
    expect(note.hidden).toBe(false)
    expect(note.textContent).toBe("Attaching a file can send it to the employer's site right away, before you submit.")
    // A2: both safety notes sit above the rows they qualify.
    const values = element("review-values")
    expect(note.compareDocumentPosition(values) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(element("page-note").compareDocumentPosition(values) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    delete (globalThis as unknown as { chrome?: typeof chrome }).chrome
    await open({ plan: PLAN_WITHOUT_DOCUMENTS })
    await review()
    expect(element("upload-note").hidden).toBe(true)
  })

  it("names a document that failed to attach, from the record a reopened popup reads", async () => {
    const failed = aRun({
      status: "done",
      completed: 2,
      total: 2,
      current: null,
      summary: summary({ fields: 2, filled: 1, documents: 1, attached: 0, failures: [{ ref: "f1", document: "resume", reason: "not_available" }] }),
    })
    await open({ run: failed })

    expect(resultLines()).toEqual(["Resume was not attached: Eve has no prepared PDF for it."])
    expect(statusText()).toBe("Filled 1 of 2. 1 thing needs you.")
  })
})

describe("U1-U4: the popup renders the run it is given", () => {
  it("U1: names the item in progress and counts what is already done", async () => {
    await open({ run: aRun() })

    expect(statusText()).toBe("Filling: First name")
    expect(progressText()).toBe("2 of 7 done")
    expect(progress().value).toBe(2)
    expect(progress().max).toBe(7)
    expect(stopButton().hidden).toBe(false)
    expect(visible(stopButton())).toBe(true)
  })

  it("U2: names a document step by the prepared PDF", async () => {
    await open({ run: aRun({ completed: 5, current: { index: 5, kind: "resume", label: "Resume" } }) })
    expect(statusText()).toBe("Attaching: Resume")
    expect(progressText()).toBe("5 of 7 done")
  })

  it("U3: reopens a stored filling run with no message, then follows storage", async () => {
    const harness = await open({ run: aRun() })
    expect(harness.sent).toEqual([])
    expect(statusText()).toBe("Filling: First name")

    harness.fire(aRun({ completed: 5, current: { index: 5, kind: "cover_letter", label: "Cover letter" } }))
    expect(statusText()).toBe("Attaching: Cover letter")
    expect(progressText()).toBe("5 of 7 done")
    expect(progress().value).toBe(5)
  })

  it("U4: each terminal status renders its copy, its application line and hides Stop", async () => {
    const done = await open({
      run: aRun({ status: "done", completed: 3, total: 3, current: null, summary: summary({ fields: 3, filled: 3 }) }),
    })
    expect(done.state.run).not.toBeNull()
    expect(statusText()).toBe("Filled 3 of 3.")
    expect(statusSub()).toBe("Acme Payments · Senior Frontend Engineer")
    expect(element("status-sub").hidden).toBe(false)
    expect(resultLines()).toEqual([])
    expect(element("result-lines").hidden).toBe(true)
    expect(stopButton().hidden).toBe(true)
    expect(element("status-icon").classList.contains("is-success")).toBe(true)

    delete (globalThis as unknown as { chrome?: typeof chrome }).chrome
    await open({
      run: aRun({
        status: "stopped",
        completed: 4,
        current: null,
        summary: summary({ filled: 2, documents: 1, attached: 1 }),
      }),
    })
    expect(statusText()).toBe("Stopped after 4 of 7. Nothing was submitted.")
    expect(resultLines()).toEqual(["What was filled stays on the page.", "Attached documents stay on the page; remove them there if you do not want them sent."])
    expect(stopButton().hidden).toBe(true)

    delete (globalThis as unknown as { chrome?: typeof chrome }).chrome
    await open({ run: aRun({ status: "failed", completed: 1, current: null, error: "The tab was closed while filling. Nothing was submitted." }) })
    expect(statusText()).toBe("The tab was closed while filling. Nothing was submitted.")
    expect(element("status-icon").classList.contains("is-destructive")).toBe(true)
    expect(stopButton().hidden).toBe(true)
  })
})

describe("U5-U6: Stop sends one message, and only when the Candidate means it", () => {
  /** Starts a fill from the popup, so the Stop button replaces the Fill button the Candidate pressed. */
  async function startFill(overrides: Partial<EveFillRun> = {}): Promise<Harness> {
    const harness = await open({ appliedRun: aRun(overrides) })
    await review()
    applyButton().click()
    await flush()
    await flush()
    return harness
  }

  it("U5: one accepted click sends one FILL_STOP and shows Stopping…", async () => {
    let clock = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const harness = await startFill()
    expect(stopButton().hidden).toBe(false)

    clock += 800
    stopButton().click()
    await flush()

    expect(harness.sent.filter((message) => message.type === "FILL_STOP")).toHaveLength(1)
    expect(stopButton().textContent).toBe("Stopping…")
    expect(stopButton().getAttribute("aria-disabled")).toBe("true")

    stopButton().click()
    await flush()
    expect(harness.sent.filter((message) => message.type === "FILL_STOP")).toHaveLength(1)
  })

  it("U6: an inert click inside the window does nothing and shows nothing; after it, a click stops; a double click and a held key never do", async () => {
    let clock = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const harness = await startFill()

    // Stop is announced and drawn as active from the first frame: the arming is a time check only.
    expect(stopButton().getAttribute("aria-disabled")).toBeNull()
    expect(stopButton().disabled).toBe(false)
    expect(stopButton().textContent).toBe("Stop")

    // Inside the 500 ms window the second half of the Fill click must not stop anything,
    // and must not change how Stop looks or is announced either.
    clock += 200
    stopButton().click()
    await flush()
    expect(harness.sent.filter((message) => message.type === "FILL_STOP")).toHaveLength(0)
    expect(stopButton().getAttribute("aria-disabled")).toBeNull()
    expect(stopButton().textContent).toBe("Stop")
    expect(stopButton().style.opacity).toBe("")

    // A double click after the window is still one choice, and not this one.
    clock += 400
    stopButton().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }))
    await flush()
    expect(harness.sent.filter((message) => message.type === "FILL_STOP")).toHaveLength(0)

    // A held Enter repeats the keydown; the click it synthesises is not a new choice.
    stopButton().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", repeat: true, bubbles: true }))
    stopButton().click()
    await flush()
    expect(harness.sent.filter((message) => message.type === "FILL_STOP")).toHaveLength(0)

    // After the window, a real click stops.
    stopButton().dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }))
    stopButton().click()
    await flush()
    expect(harness.sent.filter((message) => message.type === "FILL_STOP")).toHaveLength(1)
    expect(stopButton().getAttribute("aria-disabled")).toBe("true")
  })
})

describe("U7-U9 and D3: announcements, one start per click, and focus", () => {
  it("D3: starts the counter at zero and follows what is finished, not what is in flight", async () => {
    const harness = await open({ run: aRun({ completed: 0, current: null }) })
    expect(statusText()).toBe("Filling the values you reviewed…")
    expect(progressText()).toBe("0 of 7 done")
    expect(progress().value).toBe(0)

    harness.fire(aRun({ completed: 0, current: { index: 0, kind: "value", label: "First name" } }))
    expect(statusText()).toBe("Filling: First name")
    expect(progressText()).toBe("0 of 7 done")

    harness.fire(aRun({ completed: 1, current: { index: 1, kind: "value", label: "Email" } }))
    expect(progressText()).toBe("1 of 7 done")
    expect(progress().value).toBe(1)
  })

  it("U7: seven fast items announce at most twice, and a terminal state always lands", async () => {
    let clock = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const harness = await open({ run: aRun({ current: { index: 0, kind: "value", label: "Field 1" }, completed: 0 }) })
    const heard: string[] = [announced()]
    const counters: string[] = []

    for (let index = 1; index < 7; index++) {
      clock += 50
      harness.fire(aRun({ completed: index, current: { index, kind: "value", label: `Field ${index + 1}` } }))
      counters.push(progressText())
      // The visible line always moves; the live region may not.
      expect(statusText()).toBe(`Filling: Field ${index + 1}`)
      const latest = announced()
      if (latest !== heard.at(-1)) heard.push(latest)
    }

    expect(counters).toEqual(["1 of 7 done", "2 of 7 done", "3 of 7 done", "4 of 7 done", "5 of 7 done", "6 of 7 done"])
    expect(heard).toEqual(["Filling: Field 1"])

    clock += 50
    harness.fire(aRun({ status: "done", completed: 7, current: null, summary: summary({ fields: 7, filled: 7 }) }))
    expect(statusText()).toBe("Filled 7 of 7.")
    // A terminal state is never held back by the throttle.
    expect(announced()).toBe("Filled 7 of 7.")
  })

  it("U8: a double click on Fill sends one FILL_APPLY", async () => {
    const harness = await open()
    await review()

    applyButton().click()
    applyButton().click()
    await flush()

    expect(harness.sent.filter((message) => message.type === "FILL_APPLY")).toHaveLength(1)
  })

  it("U9: names every control, keeps one live region, and moves focus with the run", async () => {
    const harness = await open({ appliedRun: aRun() })
    expect(stopButton().getAttribute("aria-label")).toBe("Stop filling")
    expect(stopButton().textContent).toBe("Stop")
    expect(progress().getAttribute("aria-labelledby")).toBe("progress-text")
    expect(changeButton().getAttribute("aria-label")).toBe("Change Eve address")

    await review()
    applyButton().click()
    await flush()
    await flush()
    expect(document.activeElement).toBe(stopButton())

    harness.fire(aRun({ status: "done", completed: 7, current: null, summary: summary() }))
    expect(document.activeElement).toBe(fillButton())
  })

  it("D11: announces through #announce and never through the visible status", async () => {
    await open()
    expect(element("announce").getAttribute("role")).toBe("status")
    expect(element("announce").getAttribute("aria-live")).toBe("polite")
    expect(element("status").getAttribute("role")).toBeNull()
    expect(element("status").getAttribute("aria-live")).toBeNull()
    expect(element("status").getAttribute("aria-busy")).toBeNull()
    // The counter is not a live region either.
    expect(element("progress-text").closest("[aria-live]")).toBeNull()
  })
})

describe("U10 and D4: whose run the popup is looking at", () => {
  it("D4: names the other tab's application, its Stop and its counter", async () => {
    const harness = await open({ run: aRun({ tabId: 99, completed: 3 }) })
    expect(statusText()).toBe("Filling Acme Payments · Senior Frontend Engineer in another tab.")
    expect(progressText()).toBe("3 of 7 done")
    expect(progress().value).toBe(3)
    expect(visible(stopButton())).toBe(true)
    expect(stopButton().textContent).toBe("Stop the other tab's fill")
    expect(stopButton().getAttribute("aria-disabled")).toBeNull()
    // No Review values and no Connect while another tab's fill is running.
    expect(element("actions").hidden).toBe(true)
    expect(element("address-block").hidden).toBe(true)

    const sentBefore = harness.sent.length
    stopButton().click()
    stopButton().click()
    await flush()
    expect(harness.sent.length).toBe(sentBefore + 1)
    expect(harness.sent.at(-1)).toEqual({ type: "FILL_STOP" })
  })

  it("D4: falls back to 'your Eve application' and says Stopping", async () => {
    const unnamed = { ...APPLICATION, company: null, roleTitle: null }
    await open({ run: aRun({ tabId: 99, application: unnamed }) })
    expect(statusText()).toBe("Filling your Eve application in another tab.")

    delete (globalThis as unknown as { chrome?: typeof chrome }).chrome
    await open({ run: aRun({ tabId: 99, status: "stopping" }) })
    expect(statusText()).toBe("Stopping the fill in another tab…")
  })

  it("hides another tab's result and shows idle instead", async () => {
    const harness = await open({ run: aRun({ tabId: 99, completed: 3 }) })

    harness.fire(aRun({ tabId: 99, status: "done", completed: 7, current: null, summary: summary() }))
    expect(element("status").hidden).toBe(true)
    expect(stopButton().hidden).toBe(true)
    expect(fillButton().textContent).toBe("Review values")
  })

  it("renders a run older than 60 s as interrupted and sends one FILL_STOP", async () => {
    const clock = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const stale = aRun({ updatedAt: clock - 61_000 })
    const harness = await open({ run: stale })

    expect(statusText()).toBe("Filling was interrupted after 2 of 7. Nothing was submitted. Check the page, then fill again.")
    expect(harness.sent.filter((message) => message.type === "FILL_STOP")).toHaveLength(1)
    expect(stopButton().hidden).toBe(true)

    // The same record arriving again is not a second Stop.
    harness.fire({ ...stale, updatedAt: stale.updatedAt })
    expect(harness.sent.filter((message) => message.type === "FILL_STOP")).toHaveLength(1)
  })
})

describe("B6: the connection address breaks at a dot", () => {
  it("puts a <wbr> after '//' and after each dot, as text nodes and never markup", async () => {
    await open({ origin: "https://app.eve.example.com" })
    const line = element("connection-text")
    expect(line.textContent).toBe("Connected to https://app.eve.example.com")
    expect([...line.childNodes].map((node) => (node.nodeType === 3 ? node.textContent : node.nodeName))).toEqual([
      "Connected to ",
      "https://",
      "WBR",
      "app.",
      "WBR",
      "eve.",
      "WBR",
      "example.",
      "WBR",
      "com",
    ])
    // Only text and <wbr>: an address can never become an element.
    expect([...line.children].every((child) => child.nodeName === "WBR")).toBe(true)
  })

  it("keeps a hostile origin as text", async () => {
    await open({ origin: "https://<img src=x onerror=alert(1)>.example.com" })
    const line = element("connection-text")
    expect(line.querySelector("img")).toBeNull()
    expect(line.textContent).toContain("<img src=x onerror=alert(1)>")
  })

  it("is a plain sentence when not connected", async () => {
    await open({ origin: null })
    expect(element("connection-text").children).toHaveLength(0)
    expect(connectionText()).toBe("Not connected to Eve.")
  })
})

describe("D1, D2, D5 and D8: the connection line, the address block and what is on screen", () => {
  it("D5: shows one connected line and opens the address block on Change", async () => {
    await open()
    expect(connectionText()).toBe("Connected to https://eve.example.com")
    expect(changeButton().hidden).toBe(false)
    expect(element("connection-tail").hidden).toBe(false)
    expect(element("connection-tail").textContent).toBe("· Change")
    expect(changeButton().textContent).toBe("Change")
    expect(element("address-block").hidden).toBe(true)
    expect(primaries()).toEqual([fillButton()])

    changeButton().click()
    await flush()
    expect(changeButton().textContent).toBe("Cancel")
    expect(element("address-block").hidden).toBe(false)
    expect(document.activeElement).toBe(element("origin"))
    expect((element("origin") as HTMLInputElement).value).toBe("https://eve.example.com")
    // While editing, Connect is the one filled button and Review is outline.
    expect(primaries()).toEqual([element("connect")])
    expect(fillButton().classList.contains("btn-outline")).toBe(true)

    changeButton().click()
    await flush()
    expect(changeButton().textContent).toBe("Change")
    expect(element("address-block").hidden).toBe(true)
    expect(primaries()).toEqual([fillButton()])
  })

  it("D5: keeps the address block open and Change hidden with no saved address", async () => {
    await open({ origin: null })
    expect(connectionText()).toBe("Not connected to Eve.")
    expect(changeButton().hidden).toBe(true)
    expect(element("connection-tail").hidden).toBe(true)
    expect(element("address-block").hidden).toBe(false)
    expect(primaries()).toEqual([element("connect")])
  })

  it("D5: hides Change, the address block and the review button while a run is on screen", async () => {
    await open({ run: aRun() })
    expect(changeButton().hidden).toBe(true)
    expect(element("address-block").hidden).toBe(true)
    expect(element("actions").hidden).toBe(true)
    expect(primaries()).toEqual([])
  })

  it("D2: a connected popup opens with no status panel and no progress block", async () => {
    await open()
    expect(element("status").hidden).toBe(true)
    expect(element("progress-block").hidden).toBe(true)
    expect(element("result-lines").hidden).toBe(true)
  })

  it("D8: the limits paragraph belongs to a decision, not to a run in flight", async () => {
    const clock = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const cases: Array<{ view: string; options: StubOptions; review: boolean; limits: boolean }> = [
      { view: "idle", options: {}, review: false, limits: true },
      { view: "notice", options: { plan: { ok: false, error: "Eve did not answer. Nothing was submitted." } }, review: true, limits: true },
      { view: "review", options: {}, review: true, limits: true },
      { view: "planning", options: { plan: () => new Promise<EveFillPlanSummary>(() => {}) }, review: true, limits: false },
      { view: "active", options: { run: aRun() }, review: false, limits: false },
      { view: "other tab", options: { run: aRun({ tabId: 99 }) }, review: false, limits: false },
      { view: "interrupted", options: { run: aRun({ updatedAt: clock - 61_000 }) }, review: false, limits: false },
      { view: "terminal", options: { run: aRun({ status: "done", current: null, summary: summary() }) }, review: false, limits: false },
    ]

    const seen: string[] = []
    for (const entry of cases) {
      delete (globalThis as unknown as { chrome?: typeof chrome }).chrome
      await open(entry.options)
      if (entry.review) await review()
      seen.push(`${entry.view}: limits ${visible(element("limits"))} (expected ${entry.limits})`)
      // The one-line note stays on every view, a run included.
      const note = document.querySelector("footer .note")
      if (note === null) throw new Error("popup.html has no footer note")
      expect(visible(note)).toBe(true)
    }
    expect(seen).toEqual(cases.map((entry) => `${entry.view}: limits ${entry.limits} (expected ${entry.limits})`))
  })
})

describe("D6 and D7: the result headline, its rows and the plural copy", () => {
  it("D6: counts every thing that needs the Candidate and draws one row for each", async () => {
    await open({
      run: aRun({
        status: "done",
        completed: 7,
        current: null,
        summary: summary({
          fields: 4,
          filled: 4,
          documents: 2,
          attached: 1,
          unanswered: 1,
          mismatched: ["f2"],
          failures: [{ ref: "f9", document: "cover_letter", reason: "not_available" }],
        }),
      }),
    })

    expect(statusText()).toBe("Filled 5 of 7. 3 things need you.")
    expect(resultLines()).toEqual([
      "1 required field has no approved answer. It is outlined on the page.",
      "1 field did not keep the value Eve set. Check it.",
      "Cover letter was not attached: Eve has no prepared PDF for it.",
    ])
    const icons = [...document.querySelectorAll("#result-lines li svg.row-icon use")].map((use) => use.getAttribute("href"))
    expect(icons).toEqual(["#i-alert", "#i-alert", "#i-alert"])
    expect([...document.querySelectorAll("#result-lines li svg.row-icon")].every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true)
  })

  it("D6: says one thing needs you, and nothing when the run was clean", async () => {
    const failed = await open({
      run: aRun({
        status: "done",
        completed: 7,
        current: null,
        summary: summary({ fields: 6, filled: 6, documents: 1, attached: 0, failures: [{ ref: "f1", document: "resume", reason: "signed_out" }] }),
      }),
    })
    expect(failed.state.run?.status).toBe("done")
    expect(statusText()).toBe("Filled 6 of 7. 1 thing needs you.")
    expect(resultLines()).toEqual(["Resume was not attached: sign in to Eve and try again."])

    delete (globalThis as unknown as { chrome?: typeof chrome }).chrome
    await open({ run: aRun({ status: "done", completed: 7, current: null, summary: summary({ fields: 7, filled: 7 }) }) })
    expect(statusText()).toBe("Filled 7 of 7.")
    expect(resultLines()).toEqual([])
    expect(element("result-lines").hidden).toBe(true)
  })

  it("D6: a stopped run still draws its rows, with icons", async () => {
    await open({
      run: aRun({ status: "stopped", completed: 4, current: null, summary: summary({ filled: 2, documents: 1, attached: 1 }) }),
    })
    expect(statusText()).toBe("Stopped after 4 of 7. Nothing was submitted.")
    expect(resultLines()).toEqual(["What was filled stays on the page.", "Attached documents stay on the page; remove them there if you do not want them sent."])
    expect(document.querySelectorAll("#result-lines li svg.row-icon")).toHaveLength(2)
  })

  it("D6: a rendered row icon is an outline, not a filled black shape", async () => {
    // The row icon is its own <svg>, outside the sprite that carries fill and stroke, so the
    // stylesheet has to. Without it the shapes inside <use> paint with the default black fill.
    const style = document.createElement("style")
    style.textContent = readFileSync(join(process.cwd(), "src", "popup.css"), "utf8")
    document.head.append(style)
    await open({
      run: aRun({ status: "stopped", completed: 4, current: null, summary: summary({ filled: 2, documents: 1, attached: 1 }) }),
    })
    const icon = document.querySelector("#result-lines li svg.row-icon")
    expect(icon).not.toBeNull()
    const computed = getComputedStyle(icon as Element)
    // jsdom reports `fill: none` as a transparent colour; a real browser says "none" (see the sheet's checks).
    expect(["none", "rgba(0, 0, 0, 0)", "transparent"]).toContain(computed.fill)
    style.remove()
  })

  it("D7: uses plurals, quotes the real apply label, and lists unanswered fields as rows", async () => {
    const plural: EveFillPlanSummary = {
      ok: true,
      application: APPLICATION,
      fields: 4,
      values: [
        { ref: "f0", label: "First name", value: "Ada", kind: "text" },
        { ref: "f1", label: "Email", value: "ada@example.com", kind: "text" },
      ],
      documents: [{ ref: "f2", label: "Resume", document: "resume" }],
      unanswered: [{ ref: "f3", label: "Pronouns" }],
    }
    await open({ plan: plural })
    await review()

    expect(statusText()).toBe('Check the list, then press "Fill these values and documents (3)". Nothing has been filled yet.')
    expect(element("review-summary").textContent).toBe(
      "Matched Acme Payments · Senior Frontend Engineer. 2 values will be typed and 1 document will be attached; review each one. Fields with no approved answer are left empty and outlined on the page."
    )
    expect(reviewRows()).toHaveLength(4)
    const last = reviewRows()[3]
    expect(last?.querySelector(".review-label")?.textContent).toBe("Pronouns")
    expect(last?.querySelector(".review-value")?.textContent).toBe("No approved answer")
    // No "(s)" anywhere the Candidate reads.
    const visibleText = `${statusText()} ${element("review-summary").textContent ?? ""} ${reviewRows().map((row) => row.textContent).join(" ")} ${resultLines().join(" ")}`
    expect(visibleText).not.toContain("(s)")

    delete (globalThis as unknown as { chrome?: typeof chrome }).chrome
    await open({ plan: PLAN_WITHOUT_DOCUMENTS })
    await review()
    expect(element("review-summary").textContent).toBe("Matched Acme Payments · Senior Frontend Engineer. 1 value will be typed; review each one.")
    expect(statusText()).toBe('Check the list, then press "Fill these values (1)". Nothing has been filled yet.')
    expect(reviewRows()).toHaveLength(1)
  })
})

describe("D10: a sensitive value is masked until the Candidate asks for it", () => {
  const SENSITIVE_PLAN: EveFillPlanSummary = {
    ok: true,
    application: APPLICATION,
    fields: 2,
    values: [
      { ref: "f0", label: "Gender", value: "Woman", kind: "select" },
      { ref: "f1", label: "First name", value: "Ada", kind: "text" },
    ],
    documents: [],
    unanswered: [],
  }

  it("keeps the value out of the DOM, and shows it only through a native button", async () => {
    const harness = await open({ plan: SENSITIVE_PLAN })
    await review()

    const row = reviewRows()[0] as HTMLElement
    const shown = row.querySelector(".review-value") as HTMLElement
    expect(shown.textContent).toBe("•".repeat(8))
    expect(shown.getAttribute("aria-hidden")).toBe("true")
    expect(document.body.textContent).not.toContain("Woman")
    expect(row.querySelector(".sensitive")?.textContent).toBe("sensitive")

    const reveal = row.querySelector("button") as HTMLButtonElement
    expect(reveal.tagName).toBe("BUTTON")
    expect(reveal.type).toBe("button")
    expect(reveal.textContent).toBe("Show")
    expect(reveal.getAttribute("aria-label")).toBe("Show value for Gender")

    reveal.click()
    expect(shown.textContent).toBe("Woman")
    expect(shown.hasAttribute("aria-hidden")).toBe(false)
    expect(reveal.textContent).toBe("Hide")
    expect(reveal.getAttribute("aria-label")).toBe("Hide value for Gender")

    reveal.click()
    expect(shown.textContent).toBe("•".repeat(8))
    expect(shown.getAttribute("aria-hidden")).toBe("true")
    expect(reveal.textContent).toBe("Show")
    expect(document.body.textContent).not.toContain("Woman")

    // A plain row has no reveal button at all.
    expect((reviewRows()[1] as HTMLElement).querySelector("button")).toBeNull()

    // Review again puts the mask back, and the refs do not change.
    reveal.click()
    await review()
    const again = reviewRows()[0] as HTMLElement
    expect((again.querySelector(".review-value") as HTMLElement).textContent).toBe("•".repeat(8))
    expect((again.querySelector("button") as HTMLButtonElement).textContent).toBe("Show")

    applyButton().click()
    await flush()
    expect(harness.sent.filter((message) => message.type === "FILL_APPLY")).toEqual([{ type: "FILL_APPLY", refs: ["f0", "f1"] }])
  })
})

describe("U11: reduced motion is the default rendering", () => {
  it("declares every transition and animation inside prefers-reduced-motion: no-preference", () => {
    const css = readFileSync(join(process.cwd(), "src", "popup.css"), "utf8")
    const media = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{([\s\S]*)\}\s*$/.exec(css)
    expect(media).not.toBeNull()
    const outside = css.replace(media?.[0] ?? "", "")
    expect(outside).not.toMatch(/[\s;{]transition:/)
    expect(outside).not.toMatch(/[\s;{]animation:/)
    expect(media?.[1]).toContain("animation: spin")
    expect(media?.[1]).toContain("transform: scale(0.97)")
  })
})

describe("A2: the DOM order, the one filled primary, and the quiet sensitive badge", () => {
  it("shows exactly one filled primary in every view that names one", async () => {
    const views: Array<{ view: string; options: StubOptions; primaries: number }> = [
      { view: "V0 not connected", options: { origin: null }, primaries: 1 },
      { view: "V1 connected, idle", options: {}, primaries: 1 },
      { view: "V2 planning", options: { plan: () => new Promise<EveFillPlanSummary>(() => {}) }, primaries: 0 },
      { view: "V3 review", options: {}, primaries: 1 },
      { view: "V4 review empty", options: { plan: PLAN_EMPTY }, primaries: 0 },
      { view: "V5 filling, before the first item", options: { run: aRun({ completed: 0, current: null }) }, primaries: 0 },
      { view: "V6 filling a value", options: { run: aRun() }, primaries: 0 },
      { view: "V7 filling a document", options: { run: aRun({ current: { index: 5, kind: "resume", label: "Resume" } }) }, primaries: 0 },
      { view: "V8 stopping", options: { run: aRun({ status: "stopping" }) }, primaries: 0 },
      { view: "V9 done clean", options: { run: aRun({ status: "done", current: null, summary: summary() }) }, primaries: 1 },
      {
        view: "V10 done with notes",
        options: { run: aRun({ status: "done", current: null, summary: summary({ unanswered: 2 }) }) },
        primaries: 1,
      },
      { view: "V11 stopped", options: { run: aRun({ status: "stopped", completed: 3, current: null, summary: summary() }) }, primaries: 1 },
      { view: "V12 failed", options: { run: aRun({ status: "failed", current: null, error: "No form fields found on this page." }) }, primaries: 1 },
      { view: "V13 another tab", options: { run: aRun({ tabId: 99 }) }, primaries: 0 },
    ]

    const counts: string[] = []
    for (const entry of views) {
      delete (globalThis as unknown as { chrome?: typeof chrome }).chrome
      await open(entry.options)
      // The planning and review views are reached by pressing Review values.
      if (/^V[234] /.test(entry.view)) await review()
      counts.push(`${entry.view}: ${primaries().length} (expected ${entry.primaries})`)
    }
    expect(counts).toEqual(views.map((entry) => `${entry.view}: ${entry.primaries} (expected ${entry.primaries})`))
  })

  it("masks a sensitive value and marks it in words, with no red", async () => {
    const harness = await open({
      plan: {
        ok: true,
        application: APPLICATION,
        fields: 1,
        values: [
          { ref: "f0", label: "Gender", value: "Woman", kind: "select" },
          { ref: "f1", label: "First name", value: "Ada", kind: "text" },
        ],
        documents: [],
        unanswered: [],
      },
    })
    await review()

    const rows = [...document.querySelectorAll("#review-values li")]
    const sensitive = rows[0] as HTMLElement
    expect(sensitive.querySelector(".sensitive")?.textContent).toBe("sensitive")
    expect(sensitive.querySelector(".review-value")?.textContent).toBe("•".repeat(8))
    expect((rows[1] as HTMLElement).querySelector(".sensitive")).toBeNull()
    expect((rows[1] as HTMLElement).querySelector(".review-value")?.textContent).toBe("Ada")

    // The badge is muted, not red: no destructive token reaches it.
    const css = readFileSync(join(process.cwd(), "src", "popup.css"), "utf8")
    const badge = /\.sensitive\s*\{([^}]*)\}/.exec(css)
    expect(badge?.[1] ?? "").toContain("var(--muted)")
    expect(badge?.[1] ?? "").toContain("var(--muted-foreground)")
    expect(badge?.[1] ?? "").not.toMatch(/destructive|--warning/)
    expect(harness.sent.filter((message) => message.type === "FILL_PLAN")).toHaveLength(1)
  })
})
