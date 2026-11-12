import { http, HttpResponse } from "msw"
import { describe, expect, it, vi } from "vitest"

import { server } from "@/shared/testing"
import { ApiError, apiRequest, isUnauthorizedError, publicRequest } from "./http-client"

describe("apiRequest", () => {
  it("sends the session cookie mode and, for mutations, the CSRF header", async () => {
    let seen: Request | undefined
    server.use(
      http.post("/v1/thing", ({ request }) => {
        seen = request
        return new HttpResponse(null, { status: 204 })
      })
    )

    await apiRequest("/v1/thing", { method: "POST", csrfToken: "token-1" })

    expect(seen?.headers.get("x-csrf-token")).toBe("token-1")
    expect(seen?.credentials).toBe("same-origin")
  })

  it("sends no CSRF header on GET", async () => {
    let csrf: string | null = "unset"
    server.use(
      http.get("/v1/thing", ({ request }) => {
        csrf = request.headers.get("x-csrf-token")
        return HttpResponse.json({})
      })
    )

    await apiRequest("/v1/thing")

    expect(csrf).toBeNull()
  })

  it("keeps the resume refusal reason from the error envelope", async () => {
    server.use(
      http.post("/v1/thing", () =>
        HttpResponse.json(
          { error: { code: "resume_unreadable", message: "Couldn't draft a Career Profile from this file.", reason: "pages" } },
          { status: 422 }
        )
      )
    )

    const error = await apiRequest("/v1/thing", { method: "POST", csrfToken: "t" }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 422, code: "resume_unreadable", reason: "pages" })
  })

  it("keeps v1.13.0 fieldErrors from a bad_request envelope", async () => {
    const fieldErrors = [{ field: "technologies", position: 1, problem: "duplicate_entry" }]
    server.use(
      http.put("/v1/thing", () =>
        HttpResponse.json({ error: { code: "bad_request", message: "The request is not valid.", fieldErrors } }, { status: 400 })
      )
    )

    const error = await apiRequest("/v1/thing", { method: "PUT", csrfToken: "t" }).catch((e: unknown) => e)

    expect(error).toMatchObject({ status: 400, code: "bad_request", fieldErrors })
  })

  it("has no fieldErrors when the envelope carries none", async () => {
    server.use(http.get("/v1/thing", () => HttpResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 })))

    await expect(apiRequest("/v1/thing")).rejects.toMatchObject({ fieldErrors: [] })
  })

  it("has a null reason when the envelope carries none", async () => {
    server.use(
      http.get("/v1/thing", () =>
        HttpResponse.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 })
      )
    )

    await expect(apiRequest("/v1/thing")).rejects.toMatchObject({ code: "not_found", reason: null })
  })

  it("turns the contract error envelope into an ApiError", async () => {
    server.use(
      http.get("/v1/thing", () =>
        HttpResponse.json(
          { error: { code: "session_expired", message: "Your session ended." } },
          { status: 401 }
        )
      )
    )

    const error = await apiRequest("/v1/thing").catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 401, code: "session_expired" })
    expect(isUnauthorizedError(error)).toBe(true)
  })

  it("keeps the status when the body is not the envelope", async () => {
    server.use(http.get("/v1/thing", () => new HttpResponse("bad gateway", { status: 502 })))

    const error = await apiRequest("/v1/thing").catch((caught: unknown) => caught)

    expect(error).toMatchObject({ status: 502, code: null })
    expect(isUnauthorizedError(error)).toBe(false)
  })
})

describe("publicRequest", () => {
  it("omits the cookie and the CSRF header and sends JSON", async () => {
    let seen: Request | undefined
    let body: unknown
    server.use(
      http.post("/v1/public/thing", async ({ request }) => {
        seen = request
        body = await request.json()
        return HttpResponse.json({ status: "received" }, { status: 202 })
      })
    )

    // jsdom's fetch bridge drops `credentials` before MSW sees the Request, so read the init.
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    await publicRequest("/v1/public/thing", { method: "POST", json: { email: "ada@example.com" } })

    expect(fetchSpy.mock.calls[0]?.[1]?.credentials).toBe("omit")
    expect(seen?.headers.get("x-csrf-token")).toBeNull()
    expect(seen?.headers.get("content-type")).toBe("application/json")
    expect(body).toEqual({ email: "ada@example.com" })
  })

  it("keeps the access-request field codes from the error envelope", async () => {
    server.use(
      http.post("/v1/public/thing", () =>
        HttpResponse.json(
          { error: { code: "access_request_invalid", message: "Check the highlighted fields.", fields: ["email.format", "note.too_long"] } },
          { status: 400 }
        )
      )
    )

    const error = await publicRequest("/v1/public/thing", { method: "POST", json: {} }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe("access_request_invalid")
    expect((error as ApiError).fields).toEqual(["email.format", "note.too_long"])
  })
})
