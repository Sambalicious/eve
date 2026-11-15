import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/** The bridge installs itself on `globalThis`; importing it is the whole setup. */
function bridge(): EveBridgeApi {
  const api = (globalThis as unknown as { __eveBridge?: EveBridgeApi }).__eveBridge
  if (api === undefined) throw new Error("eve-bridge.js did not install __eveBridge")
  return api
}

const BODY: EveFillBody = { url: "https://boards.greenhouse.io/acme/jobs/1", fields: [] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

beforeEach(() => {
  vi.resetModules()
  delete (globalThis as unknown as { __eveBridge?: EveBridgeApi }).__eveBridge
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function load(): Promise<void> {
  // @ts-expect-error -- eve-bridge.ts is a classic injected script and has no exports.
  await import("./eve-bridge.js")
}

describe("the Eve-tab bridge (ADR 0016: the Candidate's own session, no extension credential)", () => {
  it("maps a signed-out session to unauthorized", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })))
    await load()
    expect(await bridge().fill(BODY)).toEqual({ ok: false, status: 401, error: "unauthorized" })
  })

  it("maps a refused fill request (403) to the fill failure with its status", async () => {
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(json({ csrfToken: "csrf-token" }))
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }))
    vi.stubGlobal("fetch", fetchMock)
    await load()
    expect(await bridge().fill(BODY)).toEqual({ ok: false, status: 403, error: "fill" })
  })

  it("maps a network failure to network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      })
    )
    await load()
    expect(await bridge().fill(BODY)).toEqual({ ok: false, status: 0, error: "network" })
  })

  it("aborts a session fetch at 10s and answers network instead of waiting forever", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    await load()
    const pending = bridge().fill(BODY)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toEqual({ ok: false, status: 0, error: "network" })
  })

  it("aborts a fill fetch at 20s and answers network instead of waiting forever", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(json({ csrfToken: "csrf-token" }))
    fetchMock.mockImplementationOnce(() => new Promise(() => {}))
    vi.stubGlobal("fetch", fetchMock)
    await load()
    const pending = bridge().fill(BODY)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(pending).resolves.toEqual({ ok: false, status: 0, error: "network" })
  })

  it("ignores a session answer that arrives after its timeout", async () => {
    vi.useFakeTimers()
    let answer: (response: Response) => void = () => {}
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve
          })
      )
    )
    await load()
    const pending = bridge().fill(BODY)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(pending).resolves.toEqual({ ok: false, status: 0, error: "network" })
    answer(json({ csrfToken: "csrf-token" }))
    await vi.advanceTimersByTimeAsync(0)
    expect(await pending).toEqual({ ok: false, status: 0, error: "network" })
  })

  it("maps a session the API could not serve to session, and a missing token to csrf", async () => {
    const broken = vi.fn(async () => new Response(null, { status: 500 }))
    vi.stubGlobal("fetch", broken)
    await load()
    expect(await bridge().fill(BODY)).toEqual({ ok: false, status: 500, error: "session" })

    vi.resetModules()
    const noToken = vi.fn(async () => json({}))
    vi.stubGlobal("fetch", noToken)
    await load()
    expect(await bridge().fill(BODY)).toEqual({ ok: false, status: 200, error: "csrf" })
  })

  it("sends the CSRF token and returns the response body on success", async () => {
    const body: EveFillResponseBody = { application: null, values: [], documents: [], unanswered: [] }
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(json({ csrfToken: "csrf-token" }))
    fetchMock.mockResolvedValueOnce(json(body))
    vi.stubGlobal("fetch", fetchMock)
    await load()
    expect(await bridge().fill(BODY)).toEqual({ ok: true, status: 200, body })
    const [path, init] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(path).toBe("/v1/extension/fill")
    expect(init.headers).toMatchObject({ "x-csrf-token": "csrf-token" })
    expect(init.credentials).toBe("include")
  })
})

const APPLICATION_ID = "6f1c2a4e-0000-4000-8000-000000000001"

describe("the Eve-tab bridge's document download (ADR 0016: the prepared PDF, after the review)", () => {
  it("maps a signed-out, refused and missing download to its own failure", async () => {
    for (const [status, error] of [
      [401, "unauthorized"],
      [403, "forbidden"],
      [404, "not_available"],
    ] as const) {
      vi.resetModules()
      delete (globalThis as unknown as { __eveBridge?: EveBridgeApi }).__eveBridge
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })))
      await load()
      expect(await bridge().download(APPLICATION_ID, "resume")).toEqual({ ok: false, status, error })
    }
  })

  it("refuses a redirect: fetch rejects and no file comes back", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch")
    })
    vi.stubGlobal("fetch", fetchMock)
    await load()
    // `redirect: "error"` turns an off-origin redirect into this rejection.
    expect(await bridge().download(APPLICATION_ID, "resume")).toEqual({ ok: false, status: 0, error: "download" })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.redirect).toBe("error")
    expect(init.credentials).toBe("include")
  })

  it("abandons a download fetch at 30s instead of waiting forever", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})))
    await load()
    const pending = bridge().download(APPLICATION_ID, "resume")
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(30_000)
    await expect(pending).resolves.toEqual({ ok: false, status: 0, error: "download" })
  })

  it("refuses a 200 HTML page instead of calling it a PDF", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><title>Sign in</title>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }))
    )
    await load()
    expect(await bridge().download(APPLICATION_ID, "resume")).toEqual({ ok: false, status: 200, error: "download" })
  })

  it("refuses a 2xx typed text/html even when the body starts with %PDF-", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new TextEncoder().encode("%PDF-1.7 not really"), { status: 200, headers: { "content-type": "text/html" } }))
    )
    await load()
    expect(await bridge().download(APPLICATION_ID, "resume")).toEqual({ ok: false, status: 200, error: "download" })
  })

  it("refuses a response typed application/pdf whose body does not start with %PDF-", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]), { status: 200, headers: { "content-type": "application/pdf" } }))
    )
    await load()
    expect(await bridge().download(APPLICATION_ID, "resume")).toEqual({ ok: false, status: 200, error: "download" })
  })

  it("refuses a body shorter than the %PDF- signature", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([0x25, 0x50, 0x44]), { status: 200, headers: { "content-type": "application/pdf" } })))
    await load()
    expect(await bridge().download(APPLICATION_ID, "resume")).toEqual({ ok: false, status: 200, error: "download" })
  })

  it("downloads the resume PDF, keeps the server's file name and returns bytes that decode back", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x01, 0x02, 0x03, 0xff])
    const fetchMock = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-disposition": 'attachment; filename="Ada Okafor - Resume.pdf"', "content-type": "application/pdf" },
        })
    )
    vi.stubGlobal("fetch", fetchMock)
    await load()
    const result = await bridge().download(APPLICATION_ID, "resume")
    expect(result).toMatchObject({ ok: true, name: "Ada Okafor - Resume.pdf", type: "application/pdf" })
    if (!result.ok) throw new Error("download did not succeed")
    const decoded = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0))
    expect([...decoded]).toEqual([...bytes])
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe(`/v1/applications/${APPLICATION_ID}/documents/resume.pdf`)
    expect(init.credentials).toBe("include")
    expect(init.redirect).toBe("error")
  })

  it("refuses a download over 10 MB as too_large, without base64-encoding it", async () => {
    const bytes = new Uint8Array(10 * 1024 * 1024 + 1)
    bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d])
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } })))
    await load()
    expect(await bridge().download(APPLICATION_ID, "resume")).toEqual({ ok: false, status: 200, error: "too_large" })
  })

  it("round-trips a buffer over 100 KB through base64", async () => {
    const bytes = new Uint8Array(150 * 1024)
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256
    bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d])
    vi.stubGlobal("fetch", vi.fn(async () => new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } })))
    await load()
    const result = await bridge().download(APPLICATION_ID, "resume")
    if (!result.ok) throw new Error("download did not succeed")
    const decoded = Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0))
    expect(decoded).toEqual(bytes)
  })

  it("uses the cover-letter route and a fallback name when the server sends no disposition", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL) => new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } }))
    vi.stubGlobal("fetch", fetchMock)
    await load()
    const result = await bridge().download(APPLICATION_ID, "cover_letter")
    expect(result).toMatchObject({ ok: true, name: "cover_letter.pdf", type: "application/pdf" })
    if (!result.ok) throw new Error("download did not succeed")
    expect([...Uint8Array.from(atob(result.base64), (character) => character.charCodeAt(0))]).toEqual([...bytes])
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/v1/applications/${APPLICATION_ID}/documents/cover-letter.pdf`)
  })
})

describe("the Eve-tab bridge's file name (ADR 0016: a name the Candidate can see unchanged)", () => {
  /** The header as sent: a fake response, because `Headers` refuses the bidi character this must drop. */
  function namedResponse(disposition: string): Response {
    return {
      status: 200,
      ok: true,
      headers: {
        get: (name: string) => {
          const key = name.toLowerCase()
          if (key === "content-type") return "application/pdf"
          if (key === "content-disposition") return disposition
          return null
        },
      },
      arrayBuffer: async () => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer,
    } as unknown as Response
  }

  async function nameOf(disposition: string): Promise<string> {
    vi.resetModules()
    delete (globalThis as unknown as { __eveBridge?: EveBridgeApi }).__eveBridge
    vi.stubGlobal("fetch", vi.fn(async () => namedResponse(disposition)))
    await load()
    const result = await bridge().download(APPLICATION_ID, "resume")
    if (!result.ok) throw new Error(`download did not succeed: ${result.error}`)
    return result.name
  }

  it("strips separators, '..' runs and format characters, through the header as sent", async () => {
    const cases: Array<[string, string]> = [
      ["a%2F..%2Fb.pdf", "a%2F.%2Fb.pdf"],
      ["r\u202Eesume.pdf", "resume.pdf"],
      ["../../Ada\\Resume.pdf", "AdaResume.pdf"],
      ["..\\..\\Ada/Resume.pdf", "AdaResume.pdf"],
      ["100%.pdf", "100%.pdf"],
      ["...pdf", "pdf"],
    ]
    for (const [sent, expected] of cases) {
      const name = await nameOf(`attachment; filename="${sent}"`)
      expect(name).toBe(expected)
      expect(name).not.toMatch(/[\\/]/)
      expect(name).not.toContain("..")
      expect(name).not.toMatch(/\p{Cf}/u)
    }
  })

  it("strips C0, DEL and C1 control characters from the name", async () => {
    // U+0080 to U+009F are Cc, not Cf: the format-character class does not catch them.
    const cases: Array<[string, string]> = [
      ["re\u0001sume.pdf", "resume.pdf"],
      ["re\u007Fsume.pdf", "resume.pdf"],
      ["\u0080re\u0085su\u009Fme.pdf", "resume.pdf"],
    ]
    for (const [sent, expected] of cases) {
      const name = await nameOf(`attachment; filename="${sent}"`)
      expect(name).toBe(expected)
      expect(name).not.toMatch(/\p{Cc}/u)
    }
  })

  it("falls back to the document's own name when the server's name sanitises to nothing", async () => {
    expect(await nameOf('attachment; filename="///"')).toBe("resume.pdf")
    expect(await nameOf('attachment; filename="\u202E.."')).toBe("resume.pdf")
  })
})
