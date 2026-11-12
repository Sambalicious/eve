import { type Page, expect, test } from "@playwright/test"

import { setJobCriteriaTerms, signIn } from "../support/db.ts"
import { restoreHiringInputs, snapshotHiringInputs } from "../support/hiring-db.ts"
import { HiringPage } from "../support/hiring-page.ts"
import { ADA } from "../support/stack.ts"

/**
 * EPIC-0015 Find jobs tabs: the responsive promise a browser alone can check (design note section 6).
 * At 768px the Search panel's two-column group rows must not widen the document by even a pixel; the
 * 375px and 1280px widths it must never scroll at are checked alongside it.
 */
const WIDTHS = [375, 768, 769, 1280] as const

/** The document's own width: a positive scrollWidth - clientWidth is a horizontal page scroll. */
function pageWidth(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }
  })
}

/** Every element whose painted box ends past the viewport's right edge (for the failure message). */
function widestElements(page: Page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((el) => {
        const box = el.getBoundingClientRect()
        return {
          tag: el.tagName.toLowerCase(),
          right: Math.round(box.right * 10) / 10,
          text: (el.textContent ?? "").trim().slice(0, 60),
          className: el.className.toString().slice(0, 120),
        }
      })
      .filter((entry) => entry.right > document.documentElement.clientWidth + 0.5)
      .sort((a, b) => b.right - a.right)
      .slice(0, 8)
  )
}

test.describe("EPIC-0015 Find jobs tabs at narrow, tablet and desktop widths", () => {
  let saved: Awaited<ReturnType<typeof snapshotHiringInputs>>

  test.beforeAll(async () => {
    saved = await snapshotHiringInputs()
    // React and TypeScript give the Search tab's group rows enough content to reach the widest layout.
    await setJobCriteriaTerms(ADA.email, ["React"], ["TypeScript"])
  })

  test.afterAll(async () => {
    await restoreHiringInputs(saved)
  })

  for (const width of WIDTHS) {
    test(`E15-R-${width} no horizontal page scroll on any tab at ${width}px`, async ({ page, context }) => {
      await signIn(context, ADA.email)
      await page.setViewportSize({ width, height: 900 })
      const hiring = new HiringPage(page)
      await hiring.open(null)

      for (const tab of ["Search", "Hiring posts", "Posts from your field", "Set up alerts"] as const) {
        await hiring.showTab(tab)
        const { scrollWidth, clientWidth } = await pageWidth(page)
        const detail = `${tab} at ${width}px: ${JSON.stringify(await widestElements(page))}`
        expect(scrollWidth - clientWidth, detail).toBeLessThanOrEqual(0)
      }
    })
  }
})
