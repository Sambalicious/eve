/**
 * Acceptance checks 1-4 for the committed social image (design-spec.r3-og.md).
 * Reads the committed files only; no rasterizer runs here.
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const pngPath = join(here, "..", "..", "public", "og-image.png")
const svg = readFileSync(join(here, "og-image.svg"), "utf8")

describe("og-image (design-spec.r3-og.md acceptance checks)", () => {
  it("is a 1200 × 630 PNG", () => {
    const png = readFileSync(pngPath)
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR")
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
  })

  it("is under 200 KB", () => {
    expect(statSync(pngPath).size).toBeLessThan(204_800)
  })

  it("has an SVG source with no text, images or external references", () => {
    expect(svg).not.toContain("<text")
    expect(svg).not.toContain("<image")
    expect(svg).not.toContain("href=")
    // The xmlns namespace is an identifier, not a request; nothing else may name a URL.
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', "")).not.toContain("http")
    expect(svg).toMatch(/^<svg [^>]*width="1200" height="630"/)
  })

  it("matches the stored hash, so a hand-edited SVG with a stale PNG fails", () => {
    const stored = readFileSync(join(here, "og-image.svg.sha256"), "utf8").split(/\s+/)[0]
    expect(createHash("sha256").update(svg).digest("hex")).toBe(stored)
  })

  it("keeps the rasterizer and font tools out of the app source (dev-only, MPL-2.0 note)", () => {
    const src = join(here, "..", "..", "src")
    const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((name) => /\.(ts|tsx|css)$/.test(name))
      .filter((name) => /@resvg\/|["']fontkit["']|["']wawoff2["']/.test(readFileSync(join(src, name), "utf8")))
    expect(offenders).toEqual([])
  })
})
