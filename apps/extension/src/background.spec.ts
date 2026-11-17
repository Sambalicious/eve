import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type MessageListener = (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | undefined

type StubOptions = Readonly<{
  origin?: string | null
  activeTab?: { id?: number; url?: string } | null
  eveTabs?: Array<{ id?: number; url?: string; discarded?: boolean }>
  createdTab?: { id?: number; status?: string; url?: string }
  bridge?: EveBridgeResult
  pageFields?: EvePageField[]
  unanswered?: number
  /** Document refs whose uploader refuses the file. */
  attachFailed?: string[]
  permissions?: boolean
  downloads?: Partial<Record<EveDocumentKind, EveBridgeDownloadResult>>
  downloadThrows?: boolean
  /** A page call that throws, standing in for a tab that closed mid-run. */
  throwsOn?: string
  /** A phase that never settles, standing in for a tab, Eve, or a fetch that stopped answering. */
  hangOn?: "origin" | "page" | "pageRead" | "eveTab" | "bridgeFill"
  /** The page injection waits until the test calls `releasePage`, so a late answer can be proven ignored. */
  latePage?: boolean
  /** The Eve-origin read waits until the test calls `releaseOrigin`, proving a late ceiling answer is ignored. */
  lateOrigin?: boolean
}>

const APPLICATION = { id: "6f1c2a4e-0000-4000-8000-000000000001", company: "Acme Payments", roleTitle: "Senior Frontend Engineer" }
const OK_BRIDGE: EveBridgeResult = { ok: true, status: 200, body: { application: APPLICATION, values: [], documents: [], unanswered: [] } }

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

function stubChrome(options: StubOptions = {}) {
  const origin = options.origin === undefined ? "https://eve.example.com" : options.origin
  const activeTab = options.activeTab === undefined ? { id: 1, url: "https://employer.example/apply?job=1#section" } : options.activeTab
  const eveTabs = options.eveTabs ?? [{ id: 2, url: `${origin ?? "https://eve.example.com"}/dashboard` }]
  const createdTab = options.createdTab ?? { id: 3, status: "complete", url: `${origin ?? "https://eve.example.com"}/dashboard` }
  const bridge = options.bridge ?? OK_BRIDGE
  // The page double answers from this array by reference, so a test can change what a later read would say.
  const fields: EvePageField[] = (options.pageFields ?? [{ ref: "f0", label: "First name", kind: "text", required: true }]).map((field) => ({ ...field }))
  const downloads = options.downloads ?? {}
  const attachFailed = new Set(options.attachFailed ?? [])
  const unanswered = options.unanswered ?? 0

  const sentUrls: string[] = []
  const sentBodies: EveFillBody[] = []
  const injectedTabs: number[] = []
  const downloadCalls: Array<{ applicationId: string; document: EveDocumentKind }> = []
  const sessionStore = new Map<string, unknown>()
  const runWrites: EveFillRun[] = []
  const page = {
    /** Every page call the worker made, in order. */
    calls: [] as string[],
    values: [] as EvePageValue[],
    documents: [] as EvePageDocument[],
    finishCalls: 0,
  }
  const gates = new Map<string, Promise<void>>()
  const pageGate = deferred()
  const originGate = deferred()
  let activeUrl = activeTab?.url ?? ""
  let listener: MessageListener | undefined

  /** `globalThis.__evePage`: what the injected functions call, so the worker's real calls run in the test. */
  const pageApi: EvePageApi = {
    read: () => fields,
    begin: () => {
      page.calls.push("begin")
    },
    fillValue: async (value) => {
      page.calls.push(`fillValue:${value.ref}`)
      page.values.push(value)
      if (options.throwsOn === `fillValue:${value.ref}`) throw new Error("No tab with id: 1")
      const gate = gates.get(`fillValue:${value.ref}`)
      if (gate !== undefined) await gate
      return true
    },
    attachFile: async (document) => {
      page.calls.push(`attachFile:${document.ref}`)
      page.documents.push(document)
      if (options.throwsOn === `attachFile:${document.ref}`) throw new Error("No tab with id: 1")
      const gate = gates.get(`attachFile:${document.ref}`)
      if (gate !== undefined) await gate
      return !attachFailed.has(document.ref)
    },
    finish: () => {
      page.calls.push("finish")
      page.finishCalls++
      return { unanswered }
    },
    fill: async () => ({ filled: 0, attached: 0, unanswered, mismatched: [] }),
  }

  /** `globalThis.__eveBridge`: the Eve tab's double. */
  const bridgeApi: EveBridgeApi = {
    fill: async (body) => {
      if (options.hangOn === "bridgeFill") return new Promise(() => {})
      sentUrls.push(body.url)
      sentBodies.push(body)
      return bridge
    },
    download: async (applicationId, document) => {
      downloadCalls.push({ applicationId, document })
      if (options.downloadThrows === true) throw new Error("No tab with id: 2")
      const gate = gates.get(`download:${document}`)
      if (gate !== undefined) await gate
      return downloads[document] ?? { ok: true, name: `${document}.pdf`, type: "application/pdf", base64: btoa("prepared bytes") }
    },
  }

  const scripting = {
    executeScript: vi.fn(async (injection: { target?: { tabId?: number }; files?: string[]; func?: (...args: unknown[]) => unknown; args?: unknown[] }) => {
      if (injection.target?.tabId !== undefined) injectedTabs.push(injection.target.tabId)
      // A file injection arms the tab; the calls the worker makes are functions.
      if (injection.files !== undefined) {
        if (options.hangOn === "page" && injection.files.includes("dist/page.js")) return new Promise(() => {})
        if (options.latePage === true && injection.files.includes("dist/page.js")) await pageGate.promise
        return [{ result: undefined }]
      }
      const func = injection.func
      if (func === undefined) return [{ result: null }]
      if (options.hangOn === "pageRead") return new Promise(() => {})
      const result = await func(...(injection.args ?? []))
      return [{ result: result ?? null }]
    }),
  }

  const stub = {
    runtime: {
      id: "eve-test-extension",
      getURL: (path: string) => `chrome-extension://eve-test-extension/${path}`,
      onMessage: { addListener: (fn: MessageListener) => (listener = fn) },
    },
    storage: {
      local: {
        get: vi.fn(async () => {
          if (options.hangOn === "origin") return new Promise(() => {})
          if (options.lateOrigin === true) await originGate.promise
          return origin === null ? {} : { eveOrigin: origin }
        }),
      },
      // chrome.storage.session is in-memory per browser session; this map stands in for it.
      session: {
        get: vi.fn(async (key: string) => (sessionStore.has(key) ? { [key]: sessionStore.get(key) } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items)) {
            sessionStore.set(key, value)
            if (key === "fillRun") runWrites.push(value as EveFillRun)
          }
        }),
        remove: vi.fn(async (key: string) => {
          sessionStore.delete(key)
        }),
      },
    },
    tabs: {
      query: vi.fn(async (query: { active?: boolean; currentWindow?: boolean; url?: string }) => {
        if (query.active === true) return activeUrl === "" ? [] : [{ id: activeTab?.id, url: activeUrl }]
        if (typeof query.url === "string") return options.hangOn === "eveTab" ? new Promise(() => {}) : eveTabs
        return []
      }),
      create: vi.fn(async () => ({ id: createdTab.id })),
      get: vi.fn(async (id: number) => {
        if (id === createdTab.id) return createdTab
        return { id, url: activeUrl, status: "complete" }
      }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    permissions: { contains: vi.fn(async () => options.permissions ?? true) },
    scripting,
  }

  return {
    chrome: stub,
    pageApi,
    bridgeApi,
    fields,
    page,
    sentUrls,
    sentBodies,
    injectedTabs,
    downloadCalls,
    runWrites,
    getListener: () => listener,
    setActiveUrl: (url: string) => (activeUrl = url),
    releasePage: () => pageGate.release(),
    releaseOrigin: () => originGate.release(),
    gate: (name: string) => {
      const gate = deferred()
      gates.set(name, gate.promise)
      return gate
    },
    run: () => sessionStore.get("fillRun") as EveFillRun | undefined,
    stored: (key: string) => sessionStore.get(key),
    save: (key: string, value: unknown) => sessionStore.set(key, value),
  }
}

type Stub = ReturnType<typeof stubChrome>

const loaded = new WeakMap<Stub, MessageListener>()

/** Imports the worker for this stub, once, as a browser keeps one worker. `fresh` starts a new one. */
async function load(stub: Stub, options: { fresh?: boolean } = {}): Promise<MessageListener> {
  const cached = loaded.get(stub)
  if (cached !== undefined && options.fresh !== true) return cached
  const globals = globalThis as unknown as { chrome: typeof chrome; __evePage?: EvePageApi; __eveBridge?: EveBridgeApi }
  globals.chrome = stub.chrome as unknown as typeof chrome
  globals.__evePage = stub.pageApi
  globals.__eveBridge = stub.bridgeApi
  vi.resetModules()
  // @ts-expect-error -- background.ts is a classic injected script and has no exports.
  await import("./background.js")
  const listener = stub.getListener()
  if (listener === undefined) throw new Error("background.js did not register a message listener")
  loaded.set(stub, listener)
  return listener
}

async function send(stub: Stub, message: EveExtensionRequest): Promise<unknown> {
  const listener = await load(stub)
  const globals = globalThis as unknown as { chrome: typeof chrome; __evePage?: EvePageApi; __eveBridge?: EveBridgeApi }
  globals.chrome = stub.chrome as unknown as typeof chrome
  globals.__evePage = stub.pageApi
  globals.__eveBridge = stub.bridgeApi
  return new Promise((resolve) => {
    listener(message, { id: "eve-test-extension", url: "chrome-extension://eve-test-extension/src/popup.html" }, (response) => resolve(response))
  })
}

const plan = (stub: Stub): Promise<EveFillPlanSummary> => send(stub, { type: "FILL_PLAN" }) as Promise<EveFillPlanSummary>
const apply = (stub: Stub, refs: string[]): Promise<EveFillApplyAck> => send(stub, { type: "FILL_APPLY", refs }) as Promise<EveFillApplyAck>
const stop = (stub: Stub): Promise<{ ok: true }> => send(stub, { type: "FILL_STOP" }) as Promise<{ ok: true }>

/** Waits for the stepper to write a terminal record, which is what a reopened popup reads. */
async function settled(stub: Stub): Promise<EveFillRun> {
  let found: EveFillRun | undefined
  await vi.waitFor(() => {
    found = stub.run()
    expect(found?.status ?? "none").toMatch(/^(done|stopped|failed)$/)
  })
  return found as EveFillRun
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  const globals = globalThis as unknown as { chrome?: typeof chrome; __evePage?: EvePageApi; __eveBridge?: EveBridgeApi }
  delete globals.chrome
  delete globals.__evePage
  delete globals.__eveBridge
  vi.useRealTimers()
})

describe("only the popup may ask for a fill", () => {
  it("ignores a message from a content script without injecting or calling Eve", async () => {
    const stub = stubChrome()
    const listener = await load(stub)
    let answered = false
    const returned = listener({ type: "FILL_PLAN" }, { id: "eve-test-extension", url: "https://employer.example/apply" }, () => {
      answered = true
    })
    expect(returned).toBeUndefined()
    expect(answered).toBe(false)
    expect(stub.injectedTabs).toEqual([])
    expect(stub.sentUrls).toEqual([])
  })

  it("refuses a page that merely ends in /popup.html", async () => {
    const stub = stubChrome()
    const listener = await load(stub)
    let answered = false
    const returned = listener({ type: "FILL_PLAN" }, { url: "https://employer.example/popup.html" }, () => {
      answered = true
    })
    expect(returned).toBeUndefined()
    expect(answered).toBe(false)
    expect(stub.injectedTabs).toEqual([])
  })

  it("B12: ignores FILL_STOP from a content script or from another URL", async () => {
    const stub = stubChrome()
    const listener = await load(stub)
    stub.save("fillRun", { ...aRun(), status: "filling" })

    for (const sender of [{ id: "eve-test-extension", url: "https://employer.example/apply", tab: { id: 1 } }, { url: "https://employer.example/popup.html" }]) {
      let answered = false
      const returned = listener({ type: "FILL_STOP" }, sender, () => {
        answered = true
      })
      expect(returned).toBeUndefined()
      expect(answered).toBe(false)
    }
    // The forged Stop neither wrote `stopping` nor finalised the record.
    expect(stub.run()?.status).toBe("filling")
  })
})

describe("the background worker (ADR 0016: review first, then fill only what was approved)", () => {
  it("asks the Candidate to connect Eve first", async () => {
    const stub = stubChrome({ origin: null })
    expect(await plan(stub)).toEqual({ ok: false, error: "Connect Eve first." })
    expect(stub.page.calls).toEqual([])
  })

  it("refuses a tab that is not a web page", async () => {
    const stub = stubChrome({ activeTab: { id: 1, url: "chrome://extensions" } })
    expect(await plan(stub)).toEqual({ ok: false, error: "This page can't be filled." })
  })

  it("routes a signed-out bridge answer to 'Sign in to Eve'", async () => {
    const stub = stubChrome({ bridge: { ok: false, status: 401, error: "unauthorized" } })
    expect(await plan(stub)).toEqual({ ok: false, error: "Sign in to Eve in this browser, then try again." })
  })

  it("routes a refused request (403) to its own sentence, not 'Eve answered 403'", async () => {
    const stub = stubChrome({ bridge: { ok: false, status: 403, error: "fill" } })
    expect(await plan(stub)).toEqual({ ok: false, error: "Eve refused this request. Nothing was filled." })
  })

  it("routes a throttled request (429) to a wait, not a generic status", async () => {
    const stub = stubChrome({ bridge: { ok: false, status: 429, error: "fill" } })
    expect(await plan(stub)).toEqual({ ok: false, error: "Eve is receiving too many fills. Wait a minute, then try again." })
  })

  it("routes network, session and csrf failures to their own sentences", async () => {
    expect(await plan(stubChrome({ bridge: { ok: false, status: 0, error: "network" } }))).toEqual({ ok: false, error: "Eve could not be reached. Nothing was filled." })
    expect(await plan(stubChrome({ bridge: { ok: false, status: 500, error: "session" } }))).toEqual({ ok: false, error: "Eve's session could not be read. Sign in to Eve, then try again." })
    expect(await plan(stubChrome({ bridge: { ok: false, status: 200, error: "csrf" } }))).toEqual({ ok: false, error: "Eve refused this request. Reload Eve, then try again." })
  })

  it("says 'Sign in to Eve' when a freshly opened Eve tab lands off-origin", async () => {
    const stub = stubChrome({ eveTabs: [], createdTab: { id: 3, status: "complete", url: "https://accounts.example.com/sign-in" } })
    expect(await plan(stub)).toEqual({ ok: false, error: "Sign in to Eve in this browser, then try again." })
  })

  it("prefers a live Eve tab over a discarded one", async () => {
    const stub = stubChrome({
      eveTabs: [
        { id: 4, url: "https://eve.example.com/dashboard", discarded: true },
        { id: 5, url: "https://eve.example.com/dashboard", discarded: false },
      ],
    })
    expect(await plan(stub)).toMatchObject({ ok: true })
    expect(stub.injectedTabs).toContain(5)
    expect(stub.injectedTabs).not.toContain(4)
  })

  it("sends origin, path and query but never the fragment", async () => {
    const stub = stubChrome()
    expect(await plan(stub)).toMatchObject({ ok: true })
    expect(stub.sentUrls).toEqual(["https://employer.example/apply?job=1"])
  })

  it("drops a username, a password and the fragment before sending the URL", async () => {
    const stub = stubChrome({ activeTab: { id: 1, url: "https://ada:secret@employer.example/apply?job=1#section" } })
    expect(await plan(stub)).toMatchObject({ ok: true })
    expect(stub.sentUrls).toEqual(["https://employer.example/apply?job=1"])
  })

  it("drops the query rather than sending a URL over the 2048-character cap", async () => {
    const stub = stubChrome({ activeTab: { id: 1, url: `https://employer.example/apply?${"a".repeat(2100)}` } })
    expect(await plan(stub)).toMatchObject({ ok: true })
    expect(stub.sentUrls).toEqual(["https://employer.example/apply"])
  })

  it("returns the plan with each value's page label and fills nothing on the first click", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Email", kind: "text", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: {
          application: APPLICATION,
          values: [
            { ref: "f0", value: "Ada", kind: "text" },
            { ref: "f1", value: "ada@example.com", kind: "text" },
          ],
          documents: [],
          unanswered: [],
        },
      },
    })
    expect(await plan(stub)).toEqual({
      ok: true,
      application: APPLICATION,
      fields: 2,
      values: [
        { ref: "f0", label: "First name", value: "Ada", kind: "text" },
        { ref: "f1", label: "Email", value: "ada@example.com", kind: "text" },
      ],
      documents: [],
      unanswered: [],
    })
    // The first click is a review: nothing ran on the page.
    expect(stub.page.calls).toEqual([])
  })

  it("is not an Eve application when Eve matches none", async () => {
    const stub = stubChrome({ bridge: { ok: true, status: 200, body: { application: null, values: [], documents: [], unanswered: [] } } })
    expect(await plan(stub)).toEqual({ ok: true, application: null, fields: 1, values: [], documents: [], unanswered: [] })
    expect(stub.page.calls).toEqual([])
  })

  it("times out the page inject and read at 10s with the page's own sentence", async () => {
    vi.useFakeTimers()
    const stub = stubChrome({ hangOn: "page" })
    const pending = plan(stub)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toEqual({ ok: false, error: "This page did not respond. Reload it and try again. Nothing was filled." })
    expect(stub.sentUrls).toEqual([])
  })

  it("times out a page read that starts but never answers, at the same 10s", async () => {
    vi.useFakeTimers()
    const stub = stubChrome({ hangOn: "pageRead" })
    const pending = plan(stub)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toEqual({ ok: false, error: "This page did not respond. Reload it and try again. Nothing was filled." })
    expect(stub.sentUrls).toEqual([])
  })

  it("times out finding and injecting the Eve tab at 15s", async () => {    vi.useFakeTimers()
    const stub = stubChrome({ hangOn: "eveTab" })
    const pending = plan(stub)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(pending).resolves.toEqual({ ok: false, error: "Eve did not respond. Open Eve in this browser, then try again." })
  })

  it("times out the bridge fill at 20s with 'Eve did not answer in time'", async () => {
    vi.useFakeTimers()
    const stub = stubChrome({ hangOn: "bridgeFill" })
    const pending = plan(stub)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(pending).resolves.toEqual({ ok: false, error: "Eve did not answer in time. Nothing was filled. Try again." })
  })

  it("answers at 30s even when a plan path outside every phase stops responding", async () => {
    vi.useFakeTimers()
    const stub = stubChrome({ hangOn: "origin" })
    const pending = plan(stub)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).resolves.toEqual({ ok: false, error: "Reviewing took too long. Nothing was filled. Try again." })
  })

  it("ignores a plan answer that arrives after the 30s ceiling", async () => {
    vi.useFakeTimers()
    const stub = stubChrome({ lateOrigin: true })
    const pending = plan(stub)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).resolves.toEqual({ ok: false, error: "Reviewing took too long. Nothing was filled. Try again." })

    stub.releaseOrigin()
    await vi.advanceTimersByTimeAsync(0)
    // The review ended at the ceiling: no page was read and no plan was stored for a later Apply.
    expect(stub.injectedTabs).toEqual([])
    expect(stub.stored("fillPlan")).toBeUndefined()
  })

  it("answers even when executeScript never settles and the bridge fetch never settles", async () => {
    vi.useFakeTimers()
    const pageStub = stubChrome({ hangOn: "page" })
    const pagePending = plan(pageStub)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pagePending).resolves.toEqual({ ok: false, error: "This page did not respond. Reload it and try again. Nothing was filled." })

    const bridgeStub = stubChrome({ pageFields: [{ ref: "f0", label: "First name", kind: "text", required: true }], hangOn: "bridgeFill" })
    const bridgePending = plan(bridgeStub)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(bridgePending).resolves.toEqual({ ok: false, error: "Eve did not answer in time. Nothing was filled. Try again." })
  })

  it("ignores a page answer that arrives after its timeout", async () => {
    vi.useFakeTimers()
    const stub = stubChrome({ latePage: true })
    const pending = plan(stub)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toEqual({ ok: false, error: "This page did not respond. Reload it and try again. Nothing was filled." })

    stub.releasePage()
    await vi.advanceTimersByTimeAsync(0)
    // The late read neither reached Eve nor kept the plan alive.
    expect(stub.sentUrls).toEqual([])
    expect(stub.injectedTabs).not.toContain(2)
  })

  it("B1: acks at once with a run id, and the run is filling with values plus documents", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Resume", kind: "file", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [{ ref: "f1", document: "resume" }], unanswered: [] },
      },
    })
    await plan(stub)
    const ack = await apply(stub, ["f0", "f1"])
    expect(ack).toEqual({ ok: true, runId: expect.any(String) })
    expect(stub.run()).toMatchObject({ status: "filling", total: 2, completed: 0, tabId: 1, application: APPLICATION })

    const finished = await settled(stub)
    expect(finished).toMatchObject({ status: "done", completed: 2, total: 2 })
    expect(finished.summary).toMatchObject({ fields: 2, filled: 1, documents: 1, attached: 1 })
    expect(finished.id).toBe((ack as { runId: string }).runId)
  })

  it("B2: writes the item in progress after every step, labelled from the plan", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Email", kind: "text", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: {
          application: APPLICATION,
          values: [
            { ref: "f0", value: "Ada", kind: "text" },
            { ref: "f1", value: "ada@example.com", kind: "text" },
          ],
          documents: [],
          unanswered: [],
        },
      },
    })
    await plan(stub)
    // The page's label changes after the review; the run must still say what the Candidate read.
    const first = stub.fields[0]
    if (first !== undefined) first.label = "Given name"

    await apply(stub, ["f0", "f1"])
    const finished = await settled(stub)

    const items = stub.runWrites.filter((write) => write.current !== null).map((write) => ({ current: write.current, completed: write.completed }))
    expect(items).toEqual([
      { current: { index: 0, kind: "value", label: "First name" }, completed: 0 },
      { current: { index: 1, kind: "value", label: "Email" }, completed: 1 },
    ])
    expect(finished.completed).toBe(2)
    expect(finished.current).toBeNull()
  })

  it("B3: fills the values first, then each document as a download followed by its attach", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Resume", kind: "file", required: true },
        { ref: "f2", label: "Cover letter", kind: "file", required: false },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: {
          application: APPLICATION,
          values: [{ ref: "f0", value: "Ada", kind: "text" }],
          documents: [
            { ref: "f1", document: "resume" },
            { ref: "f2", document: "cover_letter" },
          ],
          unanswered: [],
        },
      },
      downloads: { resume: { ok: true, name: "Ada Okafor - Resume.pdf", type: "application/pdf", base64: btoa("resume") } },
    })
    await plan(stub)
    // The review downloads nothing.
    expect(stub.downloadCalls).toEqual([])

    await apply(stub, ["f0", "f1", "f2"])
    const finished = await settled(stub)

    expect(stub.page.calls).toEqual(["begin", "fillValue:f0", "attachFile:f1", "attachFile:f2", "finish"])
    expect(stub.downloadCalls).toEqual([
      { applicationId: APPLICATION.id, document: "resume" },
      { applicationId: APPLICATION.id, document: "cover_letter" },
    ])
    expect(stub.page.documents.map((document) => document.name)).toEqual(["Ada Okafor - Resume.pdf", "cover_letter.pdf"])
    expect(finished).toMatchObject({ status: "done", total: 3, completed: 3 })
    expect(finished.summary).toMatchObject({ filled: 1, documents: 2, attached: 2, mismatched: [], failures: [] })
  })

  it("B4: two same-tick applies create one run and fill each ref once", async () => {
    const stub = stubChrome({
      bridge: { ok: true, status: 200, body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [], unanswered: [] } },
    })
    await plan(stub)
    const [first, second] = await Promise.all([apply(stub, ["f0"]), apply(stub, ["f0"])])

    expect([first, second].filter((ack) => ack.ok)).toHaveLength(1)
    expect([first, second].find((ack) => !ack.ok)).toEqual({ ok: false, error: "A fill is already running." })
    expect(await settled(stub)).toMatchObject({ status: "done" })
    expect(stub.page.values.filter((value) => value.ref === "f0")).toHaveLength(1)
  })

  it("B5: Stop mid-fill stops the run, runs no later item, finishes once and counts what it did", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Email", kind: "text", required: true },
        { ref: "f2", label: "Phone", kind: "text", required: false },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: {
          application: APPLICATION,
          values: [
            { ref: "f0", value: "Ada", kind: "text" },
            { ref: "f1", value: "ada@example.com", kind: "text" },
            { ref: "f2", value: "+234", kind: "text" },
          ],
          documents: [],
          unanswered: [],
        },
      },
    })
    await plan(stub)
    const gate = stub.gate("fillValue:f1")
    await apply(stub, ["f0", "f1", "f2"])
    await vi.waitFor(() => expect(stub.page.calls).toContain("fillValue:f1"))

    expect(await stop(stub)).toEqual({ ok: true })
    expect(stub.run()?.status).toBe("stopping")
    gate.release()

    const stopped = await settled(stub)
    expect(stopped.status).toBe("stopped")
    // The value in flight finished and counts: two of the three items are done.
    expect(stopped.completed).toBe(2)
    expect(stopped.summary).toMatchObject({ filled: 2 })
    // The value in flight finished and counted; the third never started.
    expect(stub.page.values.map((value) => value.ref)).toEqual(["f0", "f1"])
    expect(stub.page.finishCalls).toBe(1)
  })

  it("B6: Stop mid-download settles without the bytes, never attaches them and writes nothing after", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Resume", kind: "file", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [{ ref: "f1", document: "resume" }], unanswered: [] },
      },
    })
    await plan(stub)
    const gate = stub.gate("download:resume")
    await apply(stub, ["f0", "f1"])
    await vi.waitFor(() => expect(stub.downloadCalls).toHaveLength(1))

    await stop(stub)
    const stopped = await settled(stub)
    expect(stopped.status).toBe("stopped")
    expect(stub.page.documents).toEqual([])

    const writesAtStop = stub.runWrites.length
    gate.release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stub.page.documents).toEqual([])
    expect(stub.runWrites.length).toBe(writesAtStop)
    expect(stub.run()?.status).toBe("stopped")
  })

  it("B7: Stop with no run answers ok, and a stale filling record becomes interrupted", async () => {
    const stub = stubChrome()
    await load(stub)
    expect(await stop(stub)).toEqual({ ok: true })

    const stale: EveFillRun = { ...aRun(), status: "filling", completed: 2, total: 5 }
    stub.save("fillRun", stale)
    expect(await stop(stub)).toEqual({ ok: true })
    const failed = stub.run()
    expect(failed?.status).toBe("failed")
    expect(failed?.error).toBe("Filling was interrupted after 2 of 5. Nothing was submitted. Check the page, then fill again.")
    expect(stub.page.calls).toEqual([])
  })

  it("B8: a fresh worker fails a persisted filling run as interrupted and leaves a done one alone", async () => {
    const interrupted = stubChrome()
    await load(interrupted)
    interrupted.save("fillRun", { ...aRun(), id: "stale-run", status: "filling", completed: 1, total: 4 })
    await load(interrupted, { fresh: true })
    await vi.waitFor(() => expect(interrupted.run()?.status).toBe("failed"))
    expect(interrupted.run()?.error).toContain("interrupted after 1 of 4")

    const survived = stubChrome()
    await load(survived)
    const done: EveFillRun = {
      ...aRun(),
      id: "done-run",
      status: "done",
      completed: 4,
      total: 4,
      summary: { fields: 4, filled: 4, documents: 0, attached: 0, unanswered: 0, mismatched: [], failures: [] },
    }
    survived.save("fillRun", done)
    await load(survived, { fresh: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(survived.run()).toEqual(done)
  })

  it("B9: a page that changes mid-run fails with the page-changed copy and no finish", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Email", kind: "text", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: {
          application: APPLICATION,
          values: [
            { ref: "f0", value: "Ada", kind: "text" },
            { ref: "f1", value: "ada@example.com", kind: "text" },
          ],
          documents: [],
          unanswered: [],
        },
      },
    })
    await plan(stub)
    const gate = stub.gate("fillValue:f1")
    await apply(stub, ["f0", "f1"])
    await vi.waitFor(() => expect(stub.page.calls).toContain("fillValue:f1"))

    stub.setActiveUrl("https://employer.example/other")
    gate.release()

    const failed = await settled(stub)
    expect(failed.status).toBe("failed")
    expect(failed.error).toBe("The page changed while filling. Stopped after 2 of 2. Nothing was submitted.")
    expect(stub.page.finishCalls).toBe(0)
  })

  it("B10: an executeScript that throws fails the run with the tab-closed copy", async () => {
    const stub = stubChrome({
      pageFields: [{ ref: "f0", label: "First name", kind: "text", required: true }],
      bridge: { ok: true, status: 200, body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [], unanswered: [] } },
      throwsOn: "fillValue:f0",
    })
    await plan(stub)
    expect(await apply(stub, ["f0"])).toMatchObject({ ok: true })
    const failed = await settled(stub)
    expect(failed.status).toBe("failed")
    expect(failed.error).toBe("The tab was closed while filling. Nothing was submitted.")
    expect(failed.summary?.filled).toBe(0)
  })

  it("B11: the plan is spent at apply start, so a second apply is refused", async () => {
    const stub = stubChrome({
      pageFields: [{ ref: "f1", label: "Resume", kind: "file", required: true }],
      bridge: { ok: true, status: 200, body: { application: APPLICATION, values: [], documents: [{ ref: "f1", document: "resume" }], unanswered: [] } },
    })
    await plan(stub)
    expect(await apply(stub, ["f1"])).toMatchObject({ ok: true })
    await settled(stub)
    expect(await apply(stub, ["f1"])).toEqual({ ok: false, error: "The review expired. Review the values again." })
    expect(stub.downloadCalls).toHaveLength(1)
    expect(stub.page.documents).toHaveLength(1)
  })

  it("B13: a heartbeat refreshes the record, and the five-minute cap fails the run", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Resume", kind: "file", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [{ ref: "f1", document: "resume" }], unanswered: [] },
      },
    })
    await plan(stub)
    vi.useFakeTimers()
    const gate = stub.gate("download:resume")
    await apply(stub, ["f0", "f1"])
    // Let the stepper reach the blocked download.
    await vi.advanceTimersByTimeAsync(0)
    expect(stub.downloadCalls).toHaveLength(1)

    const before = stub.run()?.updatedAt ?? 0
    await vi.advanceTimersByTimeAsync(20_000)
    expect(stub.run()?.updatedAt ?? 0).toBeGreaterThan(before)

    // The cap is measured from the start, so the rest of the five minutes is what is left.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const failed = stub.run()
    expect(failed?.status).toBe("failed")
    expect(failed?.error).toBe("The fill took too long and was stopped after 1 of 2. Nothing was submitted.")
    gate.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(stub.page.documents).toEqual([])
  })

  it("refuses to apply a plan that was never reviewed", async () => {
    const stub = stubChrome()
    expect(await apply(stub, ["f0"])).toEqual({ ok: false, error: "The review expired. Review the values again." })
    expect(stub.page.calls).toEqual([])
  })

  it("refuses to apply after the tab moved to another page", async () => {
    const stub = stubChrome({
      bridge: { ok: true, status: 200, body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [], unanswered: [] } },
    })
    await plan(stub)
    stub.setActiveUrl("https://employer.example/other")
    expect(await apply(stub, ["f0"])).toEqual({ ok: false, error: "The page changed. Review the values again." })
    expect(stub.page.calls).toEqual([])
  })

  it("ignores a ref that was never in the plan, so a forged ref fills nothing", async () => {
    const stub = stubChrome({
      bridge: { ok: true, status: 200, body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [], unanswered: [] } },
    })
    await plan(stub)
    expect(await apply(stub, ["f9"])).toEqual({ ok: false, error: "No reviewed values were approved. Nothing was filled." })
    expect(stub.page.calls).toEqual([])
    expect(stub.run()).toBeUndefined()
  })

  it("fills only the approved subset of a plan and never types a ref left out", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Email", kind: "text", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: {
          application: APPLICATION,
          values: [
            { ref: "f0", value: "Ada", kind: "text" },
            { ref: "f1", value: "ada@example.com", kind: "text" },
          ],
          documents: [],
          unanswered: [],
        },
      },
    })
    const planned = await plan(stub)
    expect(planned).toMatchObject({ ok: true })
    if (!planned.ok || planned.application === null) throw new Error("the plan did not arrive")
    expect(planned.values).toHaveLength(2)

    // The Candidate approved the second value only.
    expect(await apply(stub, ["f1"])).toMatchObject({ ok: true })
    const finished = await settled(stub)

    // One item in the run, not two: the form counts what was approved.
    expect(finished.total).toBe(1)
    expect(finished.completed).toBe(1)
    expect(finished.summary).toMatchObject({ filled: 1 })
    expect(stub.page.values).toEqual([{ ref: "f1", value: "ada@example.com", kind: "text" }])
    expect(stub.page.calls).toEqual(["begin", "fillValue:f1", "finish"])
  })

  it("downloads and attaches only the approved document, never the one left out", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Resume", kind: "file", required: true },
        { ref: "f2", label: "Cover letter", kind: "file", required: false },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: {
          application: APPLICATION,
          values: [{ ref: "f0", value: "Ada", kind: "text" }],
          documents: [
            { ref: "f1", document: "resume" },
            { ref: "f2", document: "cover_letter" },
          ],
          unanswered: [],
        },
      },
      downloads: {
        resume: { ok: true, name: "Ada Okafor - Resume.pdf", type: "application/pdf", base64: btoa("resume") },
        cover_letter: { ok: true, name: "Ada Okafor - Cover letter.pdf", type: "application/pdf", base64: btoa("cover") },
      },
    })
    const planned = await plan(stub)
    expect(planned).toMatchObject({ ok: true })
    // The review downloads nothing.
    expect(stub.downloadCalls).toEqual([])

    // The Candidate approved the resume only.
    expect(await apply(stub, ["f0", "f1"])).toMatchObject({ ok: true })
    const finished = await settled(stub)

    expect(stub.downloadCalls).toEqual([{ applicationId: APPLICATION.id, document: "resume" }])
    expect(stub.page.calls.filter((call) => call.startsWith("attachFile:"))).toEqual(["attachFile:f1"])
    expect(stub.page.documents.map((document) => document.ref)).toEqual(["f1"])
    expect(finished.total).toBe(2)
    expect(finished.summary).toMatchObject({ documents: 1, attached: 1 })
  })

  it("reports a failed download as unattached and still fills every value", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Resume", kind: "file", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [{ ref: "f1", document: "resume" }], unanswered: [] },
      },
      downloads: { resume: { ok: false, status: 404, error: "not_available" } },
    })
    await plan(stub)
    await apply(stub, ["f0", "f1"])
    const finished = await settled(stub)

    expect(finished).toMatchObject({ status: "done", completed: 2 })
    expect(finished.summary).toMatchObject({
      filled: 1,
      documents: 1,
      attached: 0,
      failures: [{ ref: "f1", document: "resume", reason: "not_available" }],
    })
    expect(stub.page.values).toEqual([{ ref: "f0", value: "Ada", kind: "text" }])
    expect(stub.page.documents).toEqual([])
  })

  it("keeps the run going when the Eve tab throws, and names the document (TC-13)", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Resume", kind: "file", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [{ ref: "f1", document: "resume" }], unanswered: [] },
      },
      downloadThrows: true,
    })
    await plan(stub)
    await apply(stub, ["f0", "f1"])
    const finished = await settled(stub)

    // The values were already on the page; the document alone is unattached, and the record names it.
    expect(finished.status).toBe("done")
    expect(finished.summary?.failures).toEqual([{ ref: "f1", document: "resume", reason: "unattached" }])
    expect(stub.page.values).toEqual([{ ref: "f0", value: "Ada", kind: "text" }])
    expect(stub.page.finishCalls).toBe(1)
    expect(await apply(stub, ["f0", "f1"])).toEqual({ ok: false, error: "The review expired. Review the values again." })
  })

  it("reports a signed-out document download as signed_out, and still fills the values", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Resume", kind: "file", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [{ ref: "f1", document: "resume" }], unanswered: [] },
      },
      downloads: { resume: { ok: false, status: 401, error: "unauthorized" } },
    })
    await plan(stub)
    await apply(stub, ["f0", "f1"])
    const finished = await settled(stub)
    expect(finished.summary).toMatchObject({ filled: 1, attached: 0, failures: [{ ref: "f1", document: "resume", reason: "signed_out" }] })
  })

  it("reports a document the bridge found too large as too_large", async () => {
    const stub = stubChrome({
      pageFields: [
        { ref: "f0", label: "First name", kind: "text", required: true },
        { ref: "f1", label: "Resume", kind: "file", required: true },
      ],
      bridge: {
        ok: true,
        status: 200,
        body: { application: APPLICATION, values: [{ ref: "f0", value: "Ada", kind: "text" }], documents: [{ ref: "f1", document: "resume" }], unanswered: [] },
      },
      downloads: { resume: { ok: false, status: 200, error: "too_large" } },
    })
    await plan(stub)
    await apply(stub, ["f0", "f1"])
    const finished = await settled(stub)
    expect(finished.summary?.failures).toEqual([{ ref: "f1", document: "resume", reason: "too_large" }])
  })

  it("B14: the manifest asks for activeTab, scripting and storage only", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "manifest.json"), "utf8")) as { permissions?: string[] }
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"])
  })
})

/** The shape of a stored run, for the tests that seed one. */
function aRun(): EveFillRun {
  return {
    id: "seeded-run",
    status: "filling",
    tabId: 1,
    url: "https://employer.example/apply?job=1",
    application: APPLICATION,
    total: 5,
    completed: 0,
    current: null,
    summary: null,
    error: null,
    startedAt: 1,
    updatedAt: 1,
  }
}

/**
 * The wire contract. `@eve/contracts` pins this same fixture against the zod
 * schemas, so the API, the contract and this worker all fail a test when the
 * fill-plan shape changes, instead of drifting.
 */
describe("the fill-plan contract fixture", () => {
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), "../../packages/contracts/src/fixtures/extension-fill-plan.json"), "utf8"),
  ) as { request: EveFillBody; response: EveFillResponseBody }

  it("is what the worker sends and consumes: fields go out as read, labels are joined onto the plan", async () => {
    const stub = stubChrome({ pageFields: fixture.request.fields, bridge: { ok: true, status: 200, body: fixture.response } })
    const summary = await plan(stub)

    expect(stub.sentBodies).toEqual([{ url: "https://employer.example/apply?job=1", fields: fixture.request.fields }])
    expect(summary).toEqual({
      ok: true,
      application: fixture.response.application,
      fields: fixture.request.fields.length,
      values: [
        { ref: "f0", value: "Ada", kind: "text", label: "First name" },
        { ref: "f2", value: "Lagos", kind: "select", label: "Office" },
        { ref: "r0", value: "Yes", kind: "radio", label: "Work authorization" },
        { ref: "f3", value: "true", kind: "checkbox", label: "I agree to the privacy notice" },
      ],
      documents: [{ ref: "f5", document: "resume", label: "Resume" }],
      unanswered: fixture.response.unanswered,
    })
  })
})
