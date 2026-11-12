#!/usr/bin/env node
/**
 * Build-time prerender of `/` and `/about` (EPIC-0003 architecture r1 section 5).
 *  1. Copy dist/index.html to dist/app.html unchanged: the fallback for every
 *     non-public path, which keeps `noindex`.
 *  2. For `/` and `/about`: page title, landing meta (canonical tags only with
 *     a valid VITE_PUBLIC_ORIGIN), the two font preloads, the session-pending
 *     style, no robots meta, and the signed-out body inside
 *     `<div id="root" data-prerendered="...">`.
 *  3. Write dist/index.html and dist/about/index.html.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const dist = join(root, "dist")
const ssrEntry = join(root, "node_modules/.tmp/prerender/prerender.js")

const FONTS = [/^bricolage-grotesque-latin-opsz-normal-[\w-]+\.woff2$/, /^geist-latin-wght-normal-[\w-]+\.woff2$/]

const escapeAttr = (value) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
const escapeText = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;")

function fontPreloads() {
  const assets = readdirSync(join(dist, "assets"))
  return FONTS.map((pattern) => {
    const matches = assets.filter((name) => pattern.test(name))
    if (matches.length !== 1) throw new Error(`prerender: expected exactly one font matching ${pattern}, found ${matches.length}`)
    return `<link rel="preload" href="/assets/${matches[0]}" as="font" type="font/woff2" crossorigin>`
  })
}

function headTags(head) {
  return head.tags.map(({ tag, attrs }) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${escapeAttr(v)}"`).join(" ")}>`)
}

async function main() {
  const template = readFileSync(join(dist, "index.html"), "utf8")
  if (template.includes("data-prerendered")) throw new Error("prerender: dist/index.html is already prerendered; rebuild first")
  copyFileSync(join(dist, "index.html"), join(dist, "app.html"))

  const { renderLanding } = await import(pathToFileURL(ssrEntry).href)
  const origin = process.env.VITE_PUBLIC_ORIGIN
  const preloads = fontPreloads()

  for (const path of ["/", "/about"]) {
    const { body, head } = renderLanding(path, origin)
    const extra = [...headTags(head), ...preloads, "<style>html.session-pending [data-landing-root]{visibility:hidden}</style>"].join("\n    ")
    let html = template
      .replace(/<meta name="robots"[^>]*>\s*/, "")
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeText(head.title)}</title>\n    ${extra}`)
      .replace('<div id="root"></div>', `<div id="root" data-prerendered="${path}">${body}</div>`)
    if (!html.includes(`data-prerendered="${path}"`)) throw new Error("prerender: #root not found in dist/index.html")
    const out = path === "/" ? join(dist, "index.html") : join(dist, "about", "index.html")
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, html)
    console.log(`prerender: wrote ${out.replace(`${root}/`, "")} (${Buffer.byteLength(html)} bytes${origin ? `, origin ${origin}` : ", no origin"})`)
  }
}

main().catch((error) => {
  console.error(error.message ?? error)
  process.exit(1)
})
