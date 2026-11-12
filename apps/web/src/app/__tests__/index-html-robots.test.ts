import { describe, expect, it } from "vitest"

import indexHtml from "../../../index.html?raw"

/** seo-plan-slice-08: the dashboard, /postings included, is never indexable. */
describe("index.html", () => {
  it("keeps the noindex, nofollow robots meta", () => {
    const doc = new DOMParser().parseFromString(indexHtml, "text/html")
    expect(doc.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex, nofollow")
  })
})
