import { describe, expect, it } from "vitest"

import type { PageAfterSubmit } from "./form-session.js"
import { captchaVisible, detectPageBlock, judgeResult } from "./page-rules.js"
import { nextWatDay, watDay } from "./wat-day.js"

describe("block detection before the click (blocked-and-manual.feature)", () => {
  it.each([
    ["Sign in to continue. Email Password", "login"],
    ["Create an account to continue", "login"],
    ["We sent a verification code to your email. Enter the code we sent.", "email_verification"],
    ["Please complete the CAPTCHA challenge: I'm not a robot", "captcha"],
    ['Required skills assessment "Frontend skills test"', "assessment"],
  ])("%s -> %s", (text, reason) => {
    expect(detectPageBlock(text)?.reason).toBe(reason)
  })

  it("an invisible reCAPTCHA badge is not a challenge", () => {
    expect(detectPageBlock("Apply for Senior Frontend Engineer. This site is protected by reCAPTCHA.")).toBeNull()
  })

  it("the assessment detail quotes its title", () => {
    expect(detectPageBlock('Required skills assessment "Frontend skills test"')?.detail).toBe('The form includes an assessment: "Frontend skills test". Only you can take it.')
  })
})

describe("confirmation evidence (AC 6.13, 6.14)", () => {
  const HOST = "boards.greenhouse.io"
  const FORM_PAGE = [
    "Senior Frontend Engineer",
    "Acme Payments · Remote",
    "Once we have received your application, our team reviews it within a week.",
    "Thank you for applying through our careers site: we read every application.",
    "Application ID: required",
    "First Name *",
  ].join("\n")
  const after = (text: string, overrides: Partial<PageAfterSubmit> = {}): PageAfterSubmit => ({ host: HOST, text, formPresent: false, validationErrors: false, ...overrides })
  const judge = (page: PageAfterSubmit, system = "greenhouse", before = FORM_PAGE) => judgeResult({ applicationHost: HOST, applicationSystem: system, textBeforeClick: before, page })

  it("a confirmation page that replaced the form", () => {
    expect(judge(after("Thank you for applying to Acme Payments"))).toEqual({ evidence: { kind: "confirmation_page", text: "Thank you for applying to Acme Payments" }, offOriginHost: null })
  })

  it("an application ID with a digit, read case-sensitively", () => {
    expect(judge(after("Your application ID: GH-889201")).evidence).toEqual({ kind: "application_id", text: "GH-889201" })
    expect(judge(after("Application submitted! Application ID: LV-48213"), "lever").evidence).toEqual({ kind: "application_id", text: "LV-48213" })
  })

  it.each([
    ["the SEC-501 probe: an ID label followed by a word", "Application ID: required"],
    ["an ID label followed by a future-tense sentence", "Your application number will be emailed to you"],
    ["an ID label on one line and a field label on the next", "Referral reference number\nPhone"],
    ["an ID token with no digit", "Confirmation number: ABCDEFG"],
    ["a lower-case token", "Application ID: gh-889201"],
    ["a too-short token", "Application ID: A1"],
    ["job-description wording", "Once we have received your application, our team reviews it within a week."],
    ["description wording that isn't at the start of a line", "Our team says thank you for applying and will reply soon."],
    ["no evidence at all", "Processing…"],
  ])("%s is not evidence", (_name, text) => {
    expect(judge(after(text)).evidence).toBeNull()
  })

  it("the SEC-501 probe: a validation re-render that still shows the form is Uncertain, whatever its text says", () => {
    const rerender = `There was a problem with your application.\nEmail is required\n${FORM_PAGE}\nThank you for applying to Acme Payments\nApplication ID: GH-12345`
    expect(judge(after(rerender, { formPresent: true })).evidence).toBeNull()
  })

  it("visible validation errors are Uncertain even when the form element is gone", () => {
    expect(judge(after("Thank you for applying to Acme Payments", { validationErrors: true })).evidence).toBeNull()
    expect(judge(after("Thank you for applying to Acme Payments\nPlease correct the errors below")).evidence).toBeNull()
  })

  it("only text that wasn't on the page before the click counts", () => {
    const before = "Apply now\nThank you for applying to Acme Payments"
    expect(judge(after("Thank you for applying to Acme Payments"), "greenhouse", before).evidence).toBeNull()
    expect(judge(after("Thank you for applying to Acme Payments\nApplication ID: GH-777001"), "greenhouse", before).evidence).toEqual({ kind: "application_id", text: "GH-777001" })
  })

  it("SEC-502: a page off the application host after the click is Uncertain with the host noted, never Confirmed", () => {
    expect(judge(after("Thank you for applying to Acme Payments", { host: "collect.example" }))).toEqual({ evidence: null, offOriginHost: "collect.example" })
  })

  it("matches the Application System's own confirmation wording", () => {
    expect(judge(after("Application submitted!"), "lever").evidence?.kind).toBe("confirmation_page")
    expect(judge(after("Thank you for your application. We'll be in touch."), "ashby").evidence?.kind).toBe("confirmation_page")
    expect(judge(after("Thank you for applying. Your application has been received."), "greenhouse").evidence?.kind).toBe("confirmation_page")
  })

  it("no evidence is null, and a CAPTCHA after the click is noticed", () => {
    expect(judge(after("Please complete the CAPTCHA challenge")).evidence).toBeNull()
    expect(captchaVisible("Please complete the CAPTCHA challenge")).toBe(true)
  })
})

describe("WAT day boundary (daily-cap-and-duplicates.feature)", () => {
  it.each([
    ["2026-10-20T22:59:59Z", "2026-10-20"],
    ["2026-10-20T23:00:00Z", "2026-10-21"],
    ["2026-10-20T23:30:00Z", "2026-10-21"],
    ["2026-10-20T23:30:00+01:00", "2026-10-20"],
  ])("%s is WAT day %s", (at, day) => {
    expect(watDay(new Date(at))).toBe(day)
  })

  it("next day crosses months", () => {
    expect(nextWatDay("2026-10-31")).toBe("2026-11-01")
  })
})
