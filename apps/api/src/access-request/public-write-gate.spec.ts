import { ACCESS_REQUEST_PATH, ACCESS_REQUEST_PROOF_PATH } from "@eve/contracts"
import Fastify, { type FastifyInstance } from "fastify"
import { afterEach, describe, expect, it } from "vitest"

import { registerPublicWriteGate } from "./public-write-gate.js"

const ORIGIN = "https://eve.example"
const reached: string[] = []
let app: FastifyInstance | undefined

async function build(): Promise<FastifyInstance> {
  reached.length = 0
  app = Fastify()
  registerPublicWriteGate(app, ORIGIN)
  app.post(ACCESS_REQUEST_PATH, (request) => {
    reached.push(`post checked=${String(request.publicWriteChecked)}`)
    return { status: "received" }
  })
  app.get(ACCESS_REQUEST_PROOF_PATH, () => ({ proof: "p" }))
  app.post("/v1/other", (request) => {
    reached.push(`other checked=${String(request.publicWriteChecked)}`)
    return {}
  })
  return app
}

afterEach(async () => {
  await app?.close()
})

const body = JSON.stringify({ email: "ada@example.com" })
const post = (headers: Record<string, string>, payload: string = body, url = ACCESS_REQUEST_PATH) =>
  app!.inject({ method: "POST", url, payload, headers })

describe("public write gate (architecture.r1 7.2)", () => {
  it("passes an exact Origin with JSON and a small body, and marks the request", async () => {
    await build()
    const response = await post({ origin: ORIGIN, "content-type": "application/json" })
    expect(response.statusCode).toBe(200)
    expect(reached).toEqual(["post checked=true"])
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  it.each([
    ["missing", undefined],
    ["null", "null"],
    ["http scheme", "http://eve.example"],
    ["other port", "https://eve.example:8443"],
    ["other host", "https://evil.example"],
    ["suffix trick", "https://eve.example.evil.example"],
    ["prefix trick", "https://evil-eve.example"],
    ["trailing slash", "https://eve.example/"],
    ["upper case", "HTTPS://EVE.EXAMPLE"],
  ])("Origin %s is 403 origin_forbidden and never reaches the handler", async (_label, origin) => {
    await build()
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (origin !== undefined) headers.origin = origin
    const response = await post(headers)
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({ error: { code: "origin_forbidden", message: "This request must come from the Eve page." } })
    expect(reached).toEqual([])
    expect(response.headers["cache-control"]).toBe("no-store")
  })

  it.each(["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/json; charset=latin1", "application/jsonx", "text/json"])(
    "Content-Type %s is 415 before parsing",
    async (type) => {
      await build()
      const response = await post({ origin: ORIGIN, "content-type": type })
      expect(response.statusCode).toBe(415)
      expect(response.json()).toEqual({ error: { code: "unsupported_media_type", message: "The request body type is not supported." } })
      expect(reached).toEqual([])
    }
  )

  it.each(["application/json", "Application/JSON", "application/json; charset=utf-8", "application/json;charset=UTF-8"])("Content-Type %s passes", async (type) => {
    await build()
    expect((await post({ origin: ORIGIN, "content-type": type })).statusCode).toBe(200)
  })

  it("a missing Content-Type is 415", async () => {
    await build()
    const response = await app!.inject({ method: "POST", url: ACCESS_REQUEST_PATH, headers: { origin: ORIGIN } })
    expect(response.statusCode).toBe(415)
  })

  it("4096 bytes pass and 4097 bytes are 400 body.too_large", async () => {
    await build()
    const fill = (size: number) => JSON.stringify({ email: "ada@example.com", note: "x".repeat(size - JSON.stringify({ email: "ada@example.com", note: "" }).length) })
    expect(Buffer.byteLength(fill(4096))).toBe(4096)
    expect((await post({ origin: ORIGIN, "content-type": "application/json" }, fill(4096))).statusCode).toBe(200)
    const tooBig = await post({ origin: ORIGIN, "content-type": "application/json" }, fill(4097))
    expect(tooBig.statusCode).toBe(400)
    expect(tooBig.json()).toEqual({ error: { code: "access_request_invalid", message: "Check the highlighted fields.", fields: ["body.too_large"] } })
    expect(reached).toEqual(["post checked=true"])
  })

  it("Origin is checked before the content type", async () => {
    await build()
    expect((await post({ origin: "https://evil.example", "content-type": "text/plain" })).statusCode).toBe(403)
  })

  it("acts only on POST to the access-request route pattern", async () => {
    await build()
    expect((await app!.inject({ method: "GET", url: ACCESS_REQUEST_PROOF_PATH })).statusCode).toBe(200)
    const other = await post({ "content-type": "application/json" }, body, "/v1/other")
    expect(other.statusCode).toBe(200)
    expect(reached).toEqual(["other checked=undefined"])
  })

  it("matches the route, not the raw URL: a query string still goes through the gate", async () => {
    await build()
    const response = await post({ origin: "https://evil.example", "content-type": "application/json" }, body, `${ACCESS_REQUEST_PATH}?x=1`)
    expect(response.statusCode).toBe(403)
  })

  it("the proof route gets no-store", async () => {
    await build()
    expect((await app!.inject({ method: "GET", url: ACCESS_REQUEST_PROOF_PATH })).headers["cache-control"]).toBe("no-store")
  })
})
