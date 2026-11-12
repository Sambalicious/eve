import { describe, expect, it } from "vitest"

import { ApiError } from "@/shared/api"
import { feedFieldMessages, toWriteFailure, verificationFieldMessages } from "./write-failure"

const field = (f: "url" | "label" | "verifiedOn" | "verificationBasis" | "page", problem: string) =>
  ({ field: f, position: null, problem }) as never

describe("toWriteFailure (design-spec r1 error routing)", () => {
  it("401 is signed_out: the app-wide handler redirects", () => {
    expect(toWriteFailure(new ApiError(401, "session_expired", "x"))).toEqual({ kind: "signed_out" })
  })

  it("400 with Stack posts field errors goes to the fields", () => {
    const error = new ApiError(400, "bad_request", "The request is not valid.", null, [], [field("url", "duplicate")])
    expect(toWriteFailure(error)).toEqual({ kind: "fields", fieldErrors: [field("url", "duplicate")] })
  })

  it("other 4xx with a message shows it verbatim (C-SP-ERR-API)", () => {
    expect(toWriteFailure(new ApiError(409, "alert_feeds_not_verified", "Record the verification."))).toEqual({
      kind: "message",
      message: "Record the verification.",
    })
    expect(toWriteFailure(new ApiError(400, "bad_request", "The request is not valid."))).toEqual({
      kind: "message",
      message: "The request is not valid.",
    })
  })

  it("503 service_unavailable is busy (C-SP-FEED-ERR-BUSY on registration, api-contract v1.15.2)", () => {
    expect(toWriteFailure(new ApiError(503, "service_unavailable", "The service is unavailable. Try again shortly."))).toEqual({
      kind: "busy",
    })
  })

  it.each([
    ["a 503 with another code", new ApiError(503, "internal_error", "x")],
    ["a 503 without the envelope", new ApiError(503, null, "HTTP 503")],
    ["a 502 without the envelope", new ApiError(502, null, "HTTP 502")],
  ])("%s is retry, not busy", (_, error) => {
    expect(toWriteFailure(error)).toEqual({ kind: "retry" })
  })

  it.each([
    ["a 5xx with a server message", new ApiError(500, "internal_error", "Internal error")],
    ["a 4xx with a blank message", new ApiError(403, "csrf_invalid", "  ")],
    ["a body that is not the envelope", new ApiError(502, null, "HTTP 502")],
    ["a network failure", new TypeError("Failed to fetch")],
  ])("%s is retry (*-ERR-NET)", (_, error) => {
    expect(toWriteFailure(error)).toEqual({ kind: "retry" })
  })
})

describe("feedFieldMessages", () => {
  it.each([
    ["invalid_format", "This isn't a Google Alerts feed URL. Those start with https://www.google.com/alerts/feeds/"],
    ["duplicate", "This feed is already registered."],
    ["limit_reached", "The limit is 10 Alert feeds. Remove one to add another."],
    ["not_reachable", "Not reachable. Eve couldn't connect to Google. Nothing was saved. Try again shortly."],
    ["unexpected_response", "Unexpected response. Google didn't send the feed. Nothing was saved. Check the alert's RSS link."],
    ["redirected", "Redirected (not followed). Google pointed Eve elsewhere. Nothing was saved. Copy the RSS link again from Google Alerts."],
    ["not_a_feed", "Not a feed. Google sent back a page, not a feed. Nothing was saved. Check the RSS link."],
    ["too_large", "Too large. The feed is over Eve's size limit. Nothing was saved."],
    ["timed_out", "Timed out. Google didn't answer in time. Nothing was saved. Try again."],
  ])("url / %s maps to its copy deck line", (problem, text) => {
    expect(feedFieldMessages([field("url", problem)])).toEqual({ url: text })
  })

  it("label too_long and invalid both read C-SP-FEED-LABEL-ERR-LONG; url and label together", () => {
    expect(feedFieldMessages([field("url", "invalid_format"), field("label", "invalid")])).toEqual({
      url: "This isn't a Google Alerts feed URL. Those start with https://www.google.com/alerts/feeds/",
      label: "Use 60 characters or fewer.",
    })
    expect(feedFieldMessages([field("label", "too_long")])).toEqual({ label: "Use 60 characters or fewer." })
  })

  it("label invalid_characters reads C-SP-FEED-LABEL-ERR-CHARS, alongside a url error", () => {
    expect(feedFieldMessages([field("url", "invalid_format"), field("label", "invalid_characters")])).toEqual({
      url: "This isn't a Google Alerts feed URL. Those start with https://www.google.com/alerts/feeds/",
      label: "The label has a tab or hidden character. Type it again.",
    })
  })
})

describe("verificationFieldMessages", () => {
  it.each([
    [field("verifiedOn", "missing"), { date: "Enter the verification date." }],
    [field("verifiedOn", "invalid"), { date: "Enter the verification date." }],
    [field("verifiedOn", "future_date"), { date: "Enter today or an earlier date." }],
    [field("verificationBasis", "missing"), { basis: "Enter the basis for your confirmation." }],
    [field("verificationBasis", "invalid"), { basis: "Enter the basis for your confirmation." }],
    [field("verificationBasis", "too_long"), { basis: "Use 500 characters or fewer." }],
    [
      field("verificationBasis", "invalid_characters"),
      { basis: "The basis has hidden characters Eve can't save. Type it again or paste it as plain text." },
    ],
  ])("%o", (error, expected) => {
    expect(verificationFieldMessages([error])).toEqual(expected)
  })

  it("every field error of one 400 is mapped together (CR-E5-01)", () => {
    expect(verificationFieldMessages([field("verifiedOn", "future_date"), field("verificationBasis", "missing")])).toEqual({
      date: "Enter today or an earlier date.",
      basis: "Enter the basis for your confirmation.",
    })
  })
})
