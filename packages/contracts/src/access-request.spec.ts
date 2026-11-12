import { describe, expect, it } from "vitest"

import {
  ACCESS_REQUEST_BODY_MAX_BYTES,
  ACCESS_REQUEST_EMAIL_MAX,
  ACCESS_REQUEST_HONEYPOT_FIELD,
  ACCESS_REQUEST_MIN_FILL_MS,
  ACCESS_REQUEST_NOTE_MAX,
  ACCESS_REQUEST_PATH,
  ACCESS_REQUEST_PROOF_PATH,
  accessRequestAcceptedSchema,
  accessRequestBodySchema,
  accessRequestFieldCodeSchema,
  accessRequestProofSchema,
  countCodePoints,
  normalizeAccessRequest,
  trimAccessRequestEmail,
} from "./access-request.js"
import { apiErrorCodeSchema, apiErrorResponseSchema } from "./errors.js"
import { notificationStatusSchema } from "./notifications.js"

const ok = (body: unknown) => {
  const result = normalizeAccessRequest(body)
  if (!result.ok) throw new Error(`expected ok, got ${result.fields.join(",")}`)
  return result
}
const fields = (body: unknown) => {
  const result = normalizeAccessRequest(body)
  if (result.ok) throw new Error("expected field codes")
  return result.fields
}

/** 64 "a", "@", then a 189-character domain ending in ".example.com": 254 characters. */
function email254(): string {
  const domain = `${"b".repeat(60)}.${"b".repeat(60)}.${"b".repeat(55)}.example.com`
  return `${"a".repeat(64)}@${domain}`
}

describe("access-request contract constants (v1.16.0)", () => {
  it("pins the paths, limits and honeypot name", () => {
    expect(ACCESS_REQUEST_PATH).toBe("/v1/public/access-requests")
    expect(ACCESS_REQUEST_PROOF_PATH).toBe("/v1/public/access-requests/proof")
    expect(ACCESS_REQUEST_EMAIL_MAX).toBe(254)
    expect(ACCESS_REQUEST_NOTE_MAX).toBe(500)
    expect(ACCESS_REQUEST_BODY_MAX_BYTES).toBe(4096)
    expect(ACCESS_REQUEST_MIN_FILL_MS).toBe(3000)
    expect(ACCESS_REQUEST_HONEYPOT_FIELD).toBe("kiwi")
  })

  it("honeypot name avoids autofill words", () => {
    expect(ACCESS_REQUEST_HONEYPOT_FIELD).not.toMatch(/email|name|company|url|website|phone|address|tel|org/i)
  })
})

describe("schemas", () => {
  it("proof and accepted bodies are strict", () => {
    expect(accessRequestProofSchema.parse({ proof: "1.abc" })).toEqual({ proof: "1.abc" })
    expect(accessRequestProofSchema.safeParse({ proof: "" }).success).toBe(false)
    expect(accessRequestProofSchema.safeParse({ proof: "x", extra: 1 }).success).toBe(false)
    expect(accessRequestAcceptedSchema.parse({ status: "received" })).toEqual({ status: "received" })
    expect(accessRequestAcceptedSchema.safeParse({ status: "received", id: "x" }).success).toBe(false)
    expect(JSON.stringify({ status: "received" })).toHaveLength(21)
  })

  it("body schema refuses unknown keys", () => {
    expect(accessRequestBodySchema.safeParse({ email: "a@b.co", phone: "1" }).success).toBe(false)
    expect(accessRequestBodySchema.safeParse({ email: "a@b.co", note: "", proof: "p", kiwi: "" }).success).toBe(true)
  })

  it("field codes are the eight listed", () => {
    expect(accessRequestFieldCodeSchema.options).toEqual([
      "email.required",
      "email.format",
      "email.too_long",
      "note.too_long",
      "note.format",
      "body.unknown_field",
      "body.invalid_json",
      "body.too_large",
    ])
  })

  it("error codes include the four new ones, and fields rides only in the envelope", () => {
    for (const code of ["origin_forbidden", "access_request_invalid", "rate_limited_ip", "rate_limited_global"]) {
      expect(apiErrorCodeSchema.options).toContain(code)
    }
    const parsed = apiErrorResponseSchema.parse({
      error: { code: "access_request_invalid", message: "Check the highlighted fields.", fields: ["email.format", "note.too_long"] },
    })
    expect(parsed.error.fields).toEqual(["email.format", "note.too_long"])
    expect(apiErrorResponseSchema.safeParse({ error: { code: "access_request_invalid", message: "x", fields: ["nope"] } }).success).toBe(false)
  })

  it("notification status accepts the optional accessRequests counts", () => {
    const base = { senderConfigured: false, pendingCount: 0, latestFailure: null }
    expect(notificationStatusSchema.parse(base).accessRequests).toBeUndefined()
    expect(notificationStatusSchema.parse({ ...base, accessRequests: { waiting: 2, failed: 0 } }).accessRequests).toEqual({ waiting: 2, failed: 0 })
    expect(notificationStatusSchema.safeParse({ ...base, accessRequests: { waiting: -1, failed: 0 } }).success).toBe(false)
    expect(notificationStatusSchema.safeParse({ ...base, accessRequests: { waiting: 0, failed: 0, emails: [] } }).success).toBe(false)
  })
})

describe("normalizeAccessRequest: email", () => {
  it.each([
    ["field missing", {}],
    ["empty", { email: "" }],
    ["blank", { email: "   " }],
    ["zero-width only", { email: "\u200B\uFEFF" }],
  ])("%s is email.required", (_label, body) => {
    expect(fields(body)).toEqual(["email.required"])
  })

  it.each([
    "name@gmail",
    "namegmail.com",
    "name@",
    "@example.com",
    "name@@example.com",
    "ada lovelace@example.com",
    "ada@example.com, bob@example.com",
    "ada@example.com; bob@example.com",
    "<ada@example.com>",
    '"Ada" <ada@example.com>',
    '"ada"@example.com',
    "ada@example",
    "ada@-example.com",
    "ada@exa_mple.com",
    "adá@example.com",
  ])("%j is email.format", (email) => {
    expect(fields({ email })).toEqual(["email.format"])
  })

  it.each([
    "ada@example.com\r\nBcc: victim@example.net",
    "ada@example.com\nCc: victim@example.net",
    "ada@example.com\rSubject: Free money",
    "ada@example.com\u2028Bcc: victim@example.net",
    "ada@example.com>\r\nBcc: <victim@example.net",
  ])("header injection %j is email.format", (email) => {
    expect(fields({ email })).toEqual(["email.format"])
  })

  it("a non-string email is email.format", () => {
    expect(fields({ email: 12345 })).toEqual(["email.format"])
    expect(fields({ email: null })).toEqual(["email.format"])
  })

  it("accepts exactly 254 characters and refuses 255 as too long", () => {
    const e = email254()
    expect(e).toHaveLength(254)
    expect(ok({ email: e }).email).toBe(e)
    const long = `${"a".repeat(255 - "@example.com".length)}@example.com`
    expect(long).toHaveLength(255)
    expect(fields({ email: long })).toEqual(["email.too_long"])
  })

  it("accepts a 254-character email padded with 3 spaces each side", () => {
    expect(ok({ email: `   ${email254()}   ` }).email).toBe(email254())
  })

  it.each([
    "  ada@example.com  ",
    "\tada@example.com\t",
    "ada@example.com\u00A0",
    "\u200Bada@example.com\u200B",
    "\uFEFFada@example.com",
    "\u2060ada@example.com\u200D",
  ])("trims %j to ada@example.com", (raw) => {
    expect(ok({ email: raw }).email).toBe("ada@example.com")
    expect(trimAccessRequestEmail(raw)).toBe("ada@example.com")
  })

  it("keeps the typed case and lower-cases the coalesce key", () => {
    const result = ok({ email: "Ada.Okafor+eve@Example.COM" })
    expect(result.email).toBe("Ada.Okafor+eve@Example.COM")
    expect(result.emailKey).toBe("ada.okafor+eve@example.com")
  })
})

describe("normalizeAccessRequest: note", () => {
  it("absent, empty and whitespace-only notes are empty", () => {
    expect(ok({ email: "ada@example.com" }).note).toBe("")
    expect(ok({ email: "ada@example.com", note: "" }).note).toBe("")
    expect(ok({ email: "ada@example.com", note: "   \n\n  " }).note).toBe("")
  })

  it("500 code points pass, 501 fail, after trimming", () => {
    expect(ok({ email: "ada@example.com", note: "x".repeat(500) }).note).toHaveLength(500)
    expect(fields({ email: "ada@example.com", note: "x".repeat(501) })).toEqual(["note.too_long"])
    expect(ok({ email: "ada@example.com", note: `  ${"x".repeat(500)}\n\n` }).note).toBe("x".repeat(500))
  })

  it.each([
    ["é", 500, true],
    ["é", 501, false],
    ["中", 500, true],
    ["😀", 500, true],
    ["😀", 501, false],
  ] as const)("%s x %i accepted=%s (code points)", (char, count, accepted) => {
    const result = normalizeAccessRequest({ email: "ada@example.com", note: char.repeat(count) })
    expect(result.ok).toBe(accepted)
    if (!result.ok) expect(result.fields).toEqual(["note.too_long"])
  })

  it("line breaks count as one, CRLF and CR and U+2028/9 become LF", () => {
    const note = `${"x".repeat(250)}\n${"y".repeat(249)}`
    expect(countCodePoints(ok({ email: "ada@example.com", note }).note)).toBe(500)
    expect(ok({ email: "ada@example.com", note: `${"x".repeat(250)}\r\n${"y".repeat(249)}` }).note).toBe(note)
    expect(ok({ email: "ada@example.com", note: "a\rb\u2028c\u2029d" }).note).toBe("a\nb\nc\nd")
  })

  it("strips control characters except line breaks", () => {
    expect(ok({ email: "ada@example.com", note: "Hi\u0007 there\u001B[31m\nThanks\u0000" }).note).toBe("Hi there[31m\nThanks")
    expect(ok({ email: "ada@example.com", note: "a\tb\u0085c\u009Fd" }).note).toBe("abcd")
  })

  it("strips bidi controls", () => {
    expect(ok({ email: "ada@example.com", note: "abc\u202Edcba\u2066x\u2069" }).note).toBe("abcdcbax")
  })

  it("keeps markup and header-looking text literally", () => {
    expect(ok({ email: "ada@example.com", note: "<b>hi</b><script>alert(1)</script>" }).note).toBe("<b>hi</b><script>alert(1)</script>")
    expect(ok({ email: "ada@example.com", note: "Hi\r\nBcc: victim@example.net\r\nSubject: Win" }).note).toBe(
      "Hi\nBcc: victim@example.net\nSubject: Win"
    )
  })

  it("a non-string note is note.format", () => {
    expect(fields({ email: "ada@example.com", note: ["hi"] })).toEqual(["note.format"])
    expect(fields({ email: "ada@example.com", note: 5 })).toEqual(["note.format"])
  })

  it("the server count never exceeds the dialog count of the trimmed raw text", () => {
    const raw = `  ${"x".repeat(495)}\u0007\u0007\u202E\u0000z  `
    expect(countCodePoints(raw.trim())).toBe(500)
    expect(countCodePoints(ok({ email: "ada@example.com", note: raw }).note)).toBeLessThanOrEqual(500)
  })
})

describe("normalizeAccessRequest: body, proof and honeypot", () => {
  it("lists email codes before note codes", () => {
    expect(fields({ email: "name@gmail", note: "x".repeat(501) })).toEqual(["email.format", "note.too_long"])
  })

  it("an unknown key is body.unknown_field, values are never echoed", () => {
    const result = normalizeAccessRequest({ email: "ada@example.com", phone: "08031234567" })
    expect(result).toEqual({ ok: false, fields: ["body.unknown_field"] })
    expect(JSON.stringify(result)).not.toContain("0803")
  })

  it("a non-object body is body.invalid_json", () => {
    for (const body of [null, "text", 5, ["ada@example.com"]]) {
      expect(fields(body)).toEqual(["body.invalid_json"])
    }
  })

  it("proof passes through as a string or null, and a bad type is not a field error", () => {
    expect(ok({ email: "ada@example.com", proof: "1.sig" }).proof).toBe("1.sig")
    expect(ok({ email: "ada@example.com" }).proof).toBeNull()
    expect(ok({ email: "ada@example.com", proof: 5 }).proof).toBeNull()
  })

  it("honeypot is true only for a non-empty trimmed string", () => {
    expect(ok({ email: "ada@example.com", kiwi: "" }).honeypot).toBe(false)
    expect(ok({ email: "ada@example.com", kiwi: "   " }).honeypot).toBe(false)
    expect(ok({ email: "ada@example.com" }).honeypot).toBe(false)
    expect(ok({ email: "ada@example.com", kiwi: "x" }).honeypot).toBe(true)
    expect(ok({ email: "ada@example.com", kiwi: 1 }).honeypot).toBe(false)
  })
})
