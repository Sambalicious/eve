import { screen, waitFor, within } from "@testing-library/react"
import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { readyApplication, server } from "@/shared/testing"
import { openDocuments } from "./documents-helpers"

/**
 * QA gate, EPIC-0014. outreach-copy-and-email.feature, "Copy and Open in email send nothing and call
 * nothing" (AC 6.5): no other suite counts the requests a Copy or a followed mailto link causes.
 */

const BODY =
  "I built a React and TypeScript merchant dashboard from scratch to production at Brightwave Ltd. I mentored 6 junior developers. " +
  "Would you be open to referring me for the Senior Frontend Engineer role at Northwind Labs, with no pressure at all if the answer is no?"

const notWritten = (kind: string) => ({ kind, status: "idle", readerName: null, text: null, profileVersion: null, writtenAt: null, lastFailure: null, firstFailedSentence: null })

describe("outreach-copy-and-email.feature: Copy and Open in email cause no request (AC 6.5)", () => {
  it("sends no request, beacon or XHR on Copy or on following the mailto link, and never carries the quote", async () => {
    const app = readyApplication({ company: "Northwind Labs", roleTitle: "Senior Frontend Engineer" })
    const sentence = "I built the merchant dashboard in Angular."
    server.use(
      http.get("/v1/applications/:id/outreach", () =>
        HttpResponse.json({
          items: [
            {
              kind: "referral_request",
              status: "idle",
              readerName: "Amara Okafor",
              text: `Hi Amara Okafor,\n\n${BODY}`,
              profileVersion: 1,
              writtenAt: "2026-11-09T15:02:41.000Z",
              lastFailure: "blocked",
              firstFailedSentence: sentence,
            },
            notWritten("introduction"),
            notWritten("application_note"),
          ],
          approvedProfileVersion: 1,
        })
      )
    )
    const { user } = openDocuments(`/applications/${app.id}`, { applications: [app] })
    const region = await screen.findByRole("region", { name: "Outreach" })
    await waitFor(() => expect(region.querySelector('[data-slot="skeleton"]')).toBeNull())
    const link = within(region).getByRole("link", { name: /^Open in email/ })
    const href = link.getAttribute("href") ?? ""
    expect(decodeURIComponent(href)).not.toContain("Angular")

    const started: string[] = []
    const onStart = ({ request }: { request: Request }) => void started.push(`${request.method} ${request.url}`)
    server.events.on("request:start", onStart)
    const beacons: unknown[] = []
    const original = navigator.sendBeacon
    Object.defineProperty(navigator, "sendBeacon", { value: (...args: unknown[]) => beacons.push(args), configurable: true })
    const xhrOpens: unknown[] = []
    const xhrOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: [string, string]) {
      xhrOpens.push(args)
      return xhrOpen.apply(this, args as never)
    } as typeof XMLHttpRequest.prototype.open
    const stopNavigation = (event: Event) => event.preventDefault()
    document.addEventListener("click", stopNavigation)
    try {
      await user.click(within(region).getByRole("button", { name: /^Copy/ }))
      await user.click(link)
      await new Promise((resolve) => setTimeout(resolve, 150))
    } finally {
      document.removeEventListener("click", stopNavigation)
      server.events.removeListener("request:start", onStart)
      XMLHttpRequest.prototype.open = xhrOpen
      if (original === undefined) Reflect.deleteProperty(navigator, "sendBeacon")
      else Object.defineProperty(navigator, "sendBeacon", { value: original, configurable: true })
    }
    expect(started).toEqual([])
    expect(xhrOpens).toEqual([])
    expect(beacons).toEqual([])
    expect(await navigator.clipboard.readText()).toBe(`Hi Amara Okafor,\n\n${BODY}`)
  })
})
