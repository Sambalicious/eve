#!/usr/bin/env node
/**
 * Social preview image (EPIC-0003 design-spec.r3-og.md). Run by hand with
 * `pnpm --filter @eve/web og:image` when the headline, wordmark or tokens change,
 * then commit og-image.svg, og-image.svg.sha256 and public/og-image.png together.
 * The build never runs this script.
 *
 * Text is outlined to <path> with fontkit from the self-hosted @fontsource
 * variable fonts (WOFF2 decompressed with wawoff2), so the SVG embeds no fonts
 * and resvg never touches system fonts. resvg-js (MPL-2.0) is a dev-only tool.
 *
 * `--preview <dir>` also writes og-image-600.png into <dir> for the 600 × 315
 * legibility check (never into public/).
 */
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { Resvg } from "@resvg/resvg-js"
import * as fontkit from "fontkit"
import wawoff2 from "wawoff2"

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, "..", "..")
const require = createRequire(import.meta.url)

const W = 1200
const H = 630

/** Light-theme tokens as sRGB hex (design-spec.r3-og.md "Tokens as hex"). */
const TOKENS = {
  background: "#ffffff", // --background
  foreground: "#13161c", // --foreground
  primary: "#2763d7", // --primary
  persuadeInk: "#2347ae", // --persuade-ink
  persuadeAccent: "#168dd9", // --persuade-accent
  persuadeTint: "#f1f6ff", // --persuade-tint
  border: "#e2e5e8", // --border
  success: "#1f883d", // --success
  successText: "#1a7f37", // --success-text
  successMuted: "#dafbe1", // --success-muted
}

/** Copy (copy-deck.r3: landing.hero.headline, fragment_match, fragment_confirmed). */
const COPY = {
  wordmark: "Eve",
  headline: ["Applies for you.", "Asks instead", "of guessing."],
  match: "Strong core Match",
  confirmed: "Confirmed Submission",
}

/** Eve mark (shared/ui/logo.tsx) and Lucide BadgeCheck (ISC), both in a 24-unit box. */
const LOGO_PATH = "M3.75 12H20.25A8.25 8.25 0 1 0 17.83 17.83"
const BADGE_CHECK = [
  "M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z",
  "m16 9-5.5 5.5L8 12",
]

async function loadFont(spec) {
  const woff2 = readFileSync(require.resolve(spec))
  const ttf = Buffer.from(await wawoff2.decompress(woff2))
  return fontkit.create(ttf)
}

const n = (v) => Number(v.toFixed(2))

/** Lays out `text` and returns its outline path (origin at x, baseline y) and width. */
function outline(font, text, { size, axes, tracking = 0 }) {
  const face = font.getVariation(axes)
  const run = face.layout(text)
  const scale = size / face.unitsPerEm
  const track = tracking * size
  const parts = []
  let pen = 0
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i]
    const gx = pen + pos.xOffset * scale
    const gy = -pos.yOffset * scale
    const d = glyph.path
      .scale(scale, -scale)
      .translate(gx, gy)
      .toSVG()
    if (d) parts.push(d)
    pen += pos.xAdvance * scale
    if (i < run.glyphs.length - 1) pen += track
  })
  return { d: parts.join(""), width: pen }
}

function textPath(font, text, opts, x, baseline, fill) {
  const { d } = outline(font, text, opts)
  return `<path transform="translate(${n(x)} ${n(baseline)})" fill="${fill}" d="${d}"/>`
}

async function buildSvg() {
  const bricolage = await loadFont("@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-standard-normal.woff2")
  const geist = await loadFont("@fontsource-variable/geist/files/geist-latin-wght-normal.woff2")

  const display = { size: 68, axes: { wght: 650, opsz: 96 }, tracking: -0.035 }
  const mark = { size: 44, axes: { wght: 600, opsz: 96 }, tracking: -0.02 }

  // Wordmark: 40 px mark, 12 px gap, "Eve"; centred as one unit.
  const eve = outline(bricolage, COPY.wordmark, mark)
  const wordmarkLeft = 600 - (40 + 12 + eve.width) / 2
  const headlineRows = COPY.headline.map((line, i) => {
    const { width } = outline(bricolage, line, display)
    const fill = i === 0 ? TOKENS.foreground : TOKENS.persuadeInk
    return textPath(bricolage, line, display, 600 - width / 2, [320, 388, 456][i], fill)
  })

  // F2 Match chip: (40, 404) 205 × 48, rotated 2° about its centre.
  const chip = { x: 40, y: 404, w: 205, h: 48 }
  const chipSvg = `<g transform="rotate(2 ${chip.x + chip.w / 2} ${chip.y + chip.h / 2})">
<rect x="${chip.x}" y="${chip.y + 6}" width="${chip.w}" height="${chip.h}" rx="12" fill="${TOKENS.foreground}" fill-opacity="0.07"/>
<rect x="${chip.x}" y="${chip.y}" width="${chip.w}" height="${chip.h}" rx="12" fill="#ffffff" stroke="${TOKENS.border}" stroke-width="1.5"/>
${[8, 12, 16].map((h, i) => `<rect x="${chip.x + 16 + i * 6}" y="${chip.y + 34 - h}" width="4" height="${h}" rx="1" fill="${TOKENS.primary}"/>`).join("")}
${textPath(geist, COPY.match, { size: 17, axes: { wght: 500 } }, chip.x + 42, chip.y + 30, TOKENS.foreground)}
</g>`

  // F3 Confirmed stamp: (941, 206) 227 × 56, rotated -6°.
  const st = { x: 941, y: 206, w: 227, h: 56 }
  const badgeScale = 18 / 24
  const stampSvg = `<g transform="rotate(-6 ${st.x + st.w / 2} ${st.y + st.h / 2})">
<rect x="${st.x}" y="${st.y}" width="${st.w}" height="${st.h}" rx="14" fill="${TOKENS.successMuted}"/>
<rect x="${st.x + 5}" y="${st.y + 5}" width="${st.w - 10}" height="${st.h - 10}" rx="10" fill="none" stroke="${TOKENS.success}" stroke-width="1.5" stroke-dasharray="4 3"/>
<g transform="translate(${st.x + 14} ${st.y + 19}) scale(${badgeScale})" fill="none" stroke="${TOKENS.successText}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${BADGE_CHECK.map((d) => `<path d="${d}"/>`).join("")}</g>
${textPath(geist, COPY.confirmed, { size: 16, axes: { wght: 600 } }, st.x + 40, st.y + 33, TOKENS.successText)}
</g>`

  // F4 Envelope at (1036, 414), rotated 4°.
  const envSvg = `<g transform="translate(1036 414) rotate(4 48 33)">
<rect x="0" y="0" width="96" height="66" rx="8" fill="#ffffff" stroke="${TOKENS.primary}" stroke-width="2" stroke-linejoin="round"/>
<polyline points="8,10 48,40 88,10" fill="none" stroke="${TOKENS.primary}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="92" cy="4" r="10.5" fill="#ffffff"/>
<circle cx="92" cy="4" r="9" fill="${TOKENS.persuadeAccent}"/>
</g>`

  const logoScale = 40 / 24
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="field" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${TOKENS.persuadeTint}"/><stop offset="0.92" stop-color="#ffffff"/></linearGradient>
<radialGradient id="ra" gradientUnits="userSpaceOnUse" cx="216" cy="139" r="720" gradientTransform="translate(216 139) scale(1 0.4375) translate(-216 -139)"><stop offset="0" stop-color="${TOKENS.primary}" stop-opacity="0.14"/><stop offset="0.7" stop-color="${TOKENS.primary}" stop-opacity="0"/></radialGradient>
<radialGradient id="rb" gradientUnits="userSpaceOnUse" cx="1020" cy="189" r="600" gradientTransform="translate(1020 189) scale(1 0.4725) translate(-1020 -189)"><stop offset="0" stop-color="${TOKENS.persuadeAccent}" stop-opacity="0.12"/><stop offset="0.7" stop-color="${TOKENS.persuadeAccent}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#field)"/>
<rect width="${W}" height="${H}" fill="url(#ra)"/>
<rect width="${W}" height="${H}" fill="url(#rb)"/>
<g transform="translate(${n(wordmarkLeft)} 166) scale(${n(logoScale)})"><path d="${LOGO_PATH}" fill="none" stroke="${TOKENS.primary}" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></g>
${textPath(bricolage, COPY.wordmark, mark, wordmarkLeft + 52, 206, TOKENS.foreground)}
${headlineRows.join("\n")}
${chipSvg}
${stampSvg}
${envSvg}
</svg>
`
}

function render(svg, width) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: false },
    background: TOKENS.background,
  })
  return resvg.render().asPng()
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex")

async function main() {
  const svg = await buildSvg()
  const png = render(svg, W)
  writeFileSync(join(here, "og-image.svg"), svg)
  writeFileSync(join(here, "og-image.svg.sha256"), `${sha256(svg)}  og-image.svg\n`)
  writeFileSync(join(webRoot, "public", "og-image.png"), png)
  console.log(`og-image: svg ${Buffer.byteLength(svg)} B, png ${png.length} B, sha256 ${sha256(svg)}`)

  const at = process.argv.indexOf("--preview")
  if (at !== -1) {
    const dir = process.argv[at + 1]
    if (!dir) throw new Error("--preview needs a directory")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "og-image-600.png"), render(svg, 600))
    console.log(`og-image: preview ${join(dir, "og-image-600.png")}`)
  }
}

await main()
