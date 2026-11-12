import { render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it } from "vitest"

import { LandingContent } from "@/pages/landing"
import { renderLanding } from "./prerender"

const ALT = 'The Eve wordmark above the line "Applies for you. Asks instead of guessing."'

/** Normalizes markup so server and client output compare structurally. */
const normalize = (markup: string) => {
  const box = document.createElement("div")
  box.innerHTML = markup
  // Base UI ids differ between renderToString and render; React adds text separators on the server.
  return box.innerHTML
    .replace(/\s(data-discover|style|id="base-ui-[^"]*")="?[^"]*"?/g, "")
    .replace(/\sid="base-ui-[^"]*"/g, "")
    .replace(/<!--\s*-->/g, "")
}

describe("prerender (architecture r1 section 5)", () => {
  it("renders the signed-out page: three Sign in links, no dashboard link, no form", () => {
    const { body } = renderLanding("/", undefined)
    expect(body.match(/>Sign in</g)).toHaveLength(3)
    expect(body).not.toContain("Open dashboard")
    expect(body).not.toMatch(/<form|<input|<textarea|mailto:/)
    // r3 two-tone headline: the second sentence is its own ink span; the text is the approved string.
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(body)![1].replace(/<[^>]+>/g, "")
    expect(h1).toBe("Applies for you. Asks instead of guessing.")
    expect(body).toMatch(/data-landing-root="(true|)"/)
  })

  it("matches the client's first render (hydration parity)", () => {
    const { body } = renderLanding("/", undefined)
    const { container } = render(
      <div className="font-sans antialiased">
        <MemoryRouter>
          <LandingContent path="/" signedIn={false} />
        </MemoryRouter>
      </div>
    )
    // The client hides Replay without motion, as the server does; the frame's data-motion is set after mount.
    const client = container.innerHTML.replace(/data-motion="end"/, 'data-motion="armed"')
    expect(normalize(client)).toBe(normalize(body))
  })

  it("adds canonical and og:url only for a valid https origin; /about is canonical to /", () => {
    const tags = (path: "/" | "/about", origin?: string) => renderLanding(path, origin).head.tags
    expect(tags("/").some((t) => t.attrs.rel === "canonical")).toBe(false)
    expect(tags("/", "http://eve.example").some((t) => t.attrs.rel === "canonical")).toBe(false)
    expect(tags("/", "https://eve.example/path").some((t) => t.attrs.rel === "canonical")).toBe(false)
    const about = tags("/about", "https://eve.example")
    expect(about.find((t) => t.attrs.rel === "canonical")?.attrs.href).toBe("https://eve.example/")
    expect(about.find((t) => t.attrs.property === "og:url")?.attrs.content).toBe("https://eve.example/about")
    expect(about.find((t) => t.attrs.property === "og:image")?.attrs.content).toBe("https://eve.example/og-image.png")
  })

  it("emits the og:image block only with VITE_PUBLIC_ORIGIN set (design-spec.r3-og.md Emission)", () => {
    const gated = ["og:image", "og:image:width", "og:image:height", "og:image:type", "twitter:image"]
    const value = (tags: ReturnType<typeof renderLanding>["head"]["tags"], key: string) =>
      tags.find((t) => t.attrs.property === key || t.attrs.name === key)?.attrs.content
    for (const path of ["/", "/about"] as const) {
      const withOrigin = renderLanding(path, "https://eve.example").head.tags
      expect(value(withOrigin, "og:image")).toBe("https://eve.example/og-image.png")
      expect(value(withOrigin, "twitter:image")).toBe("https://eve.example/og-image.png")
      expect(value(withOrigin, "og:image:width")).toBe("1200")
      expect(value(withOrigin, "og:image:height")).toBe("630")
      expect(value(withOrigin, "og:image:type")).toBe("image/png")

      const without = renderLanding(path, undefined).head.tags
      for (const key of gated) expect(value(without, key)).toBeUndefined()
      expect(without.some((t) => Object.values(t.attrs).some((v) => v.includes("og-image")))).toBe(false)

      for (const tags of [withOrigin, without]) {
        expect(value(tags, "og:image:alt")).toBe(ALT)
        expect(value(tags, "twitter:image:alt")).toBe(ALT)
        expect(value(tags, "twitter:card")).toBe("summary_large_image")
      }
    }
  })

  it("uses the deck's title and description", () => {
    const { head } = renderLanding("/", undefined)
    expect(head.title).toBe("Eve, the job assistant that asks instead of guessing")
    expect(head.tags.find((t) => t.attrs.name === "description")?.attrs.content).toBe(
      "Eve finds roles you can be hired for, writes resumes from your own record and applies up to five times a day. Access is by invite."
    )
  })
})
