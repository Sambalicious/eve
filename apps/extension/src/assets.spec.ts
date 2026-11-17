import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * A1: the asset and style contract. The popup is styled from files the browser
 * loads directly, so a font that was not copied, a token that drifted from the
 * app or a colour pair that slipped under AA is caught here rather than in a
 * screenshot review.
 */
const EXTENSION = process.cwd()
const SRC = join(EXTENSION, "src")
const APP_TOKENS = join(EXTENSION, "..", "web", "src", "app", "styles", "index.css")

const CSS = readFileSync(join(SRC, "popup.css"), "utf8")
const HTML = readFileSync(join(SRC, "popup.html"), "utf8")
const APP = readFileSync(APP_TOKENS, "utf8")

/** Every token the popup shares with the app. `--field-edge` is popup-local and not compared. */
const SHARED = [
  "--background",
  "--foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--primary",
  "--primary-foreground",
  "--ring",
  "--border",
  "--success-text",
  "--warning-text",
  "--destructive-text",
] as const

function block(source: string, pattern: RegExp): string {
  const found = pattern.exec(source)
  if (found === null) throw new Error(`no block for ${pattern}`)
  return found[1] ?? ""
}

function declarations(source: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const match of source.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const name = match[1]
    const value = match[2]
    if (name !== undefined && value !== undefined) found.set(name, value.replace(/\s+/g, " ").trim())
  }
  return found
}

/** Resolves `var(--x)` against the same block, so `--warning-text: var(--warning)` compares as a colour. */
function resolve(name: string, tokens: Map<string, string>): string {
  let value = tokens.get(name) ?? ""
  for (let depth = 0; depth < 3; depth++) {
    const reference = /^var\((--[\w-]+)\)$/.exec(value)
    if (reference === null) return value
    value = tokens.get(reference[1] ?? "") ?? ""
  }
  return value
}

const POPUP_LIGHT = declarations(block(CSS, /:root\s*\{([^}]*)\}/))
const POPUP_DARK = declarations(block(CSS, /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/))
const APP_LIGHT = declarations(block(APP, /:root\s*\{([^}]*)\}/))
const APP_DARK = declarations(block(APP, /\n\.dark\s*\{([^}]*)\}/))

interface Color {
  L: number
  C: number
  H: number
}

function color(text: string): Color {
  const parsed = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text)
  if (parsed === null) throw new Error(`not an oklch colour: ${text}`)
  return { L: Number(parsed[1]), C: Number(parsed[2]), H: Number(parsed[3]) }
}

/** OKLCH to linear sRGB (Björn Ottosson's matrices), clamped to the gamut, then WCAG relative luminance. */
function luminanceText(text: string): number {
  const { L, C, H } = color(text)
  const radians = (H * Math.PI) / 180
  const a = C * Math.cos(radians)
  const b = C * Math.sin(radians)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const channels = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.min(1, Math.max(0, channel)))
  const [red, green, blue] = channels
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0)
}

function contrast(one: string, other: string): number {
  const first = luminanceText(one)
  const second = luminanceText(other)
  const [light, dark] = first > second ? [first, second] : [second, first]
  return (light + 0.05) / (dark + 0.05)
}

function token(map: Map<string, string>, name: string): string {
  const value = resolve(name, map)
  if (value === "") throw new Error(`popup.css does not declare ${name}`)
  return value
}

describe("A1: fonts are bundled, declared and preloaded from the extension's own origin", () => {
  const fonts = [
    "geist-latin-wght-normal.woff2",
    "geist-latin-ext-wght-normal.woff2",
    "bricolage-grotesque-latin-opsz-normal.woff2",
  ]

  it("ships the three faces and both licence files, at the measured sizes", () => {
    // The byte counts of @fontsource-variable 5.3.0, the version the web app pins.
    const expected: Record<string, number> = {
      "geist-latin-wght-normal.woff2": 29400,
      "geist-latin-ext-wght-normal.woff2": 16512,
      "bricolage-grotesque-latin-opsz-normal.woff2": 76888,
      "OFL-Geist.txt": 4486,
      "OFL-Bricolage-Grotesque.txt": 4401,
    }
    for (const [name, bytes] of Object.entries(expected)) {
      expect(`${name}:${statSync(join(SRC, "fonts", name)).size}`).toBe(`${name}:${bytes}`)
    }
  })

  it("declares one @font-face per file, each blocking the fallback flash", () => {
    const faces = [...CSS.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1] ?? "")
    expect(faces).toHaveLength(3)
    for (const file of fonts) {
      const face = faces.find((body) => body.includes(file))
      expect(face, `${file} has no @font-face`).toBeDefined()
      expect(face).toContain("font-display: block")
      expect(face).toContain("format(\"woff2-variations\")")
      expect(face).toContain("unicode-range:")
    }
  })

  it("preloads the two above-the-fold faces with crossorigin", () => {
    const parsed = new DOMParser().parseFromString(HTML, "text/html")
    const preloads = [...parsed.querySelectorAll('link[rel="preload"]')]
    expect(preloads.map((link) => link.getAttribute("href"))).toEqual([
      "fonts/geist-latin-wght-normal.woff2",
      "fonts/bricolage-grotesque-latin-opsz-normal.woff2",
    ])
    for (const link of preloads) {
      expect(link.getAttribute("as")).toBe("font")
      expect(link.getAttribute("type")).toBe("font/woff2")
      expect(link.hasAttribute("crossorigin")).toBe(true)
    }
  })
})

describe("A1: the tokens are the app's, in light and dark", () => {
  it("declares every shared token with the app's exact value", () => {
    const drift: string[] = []
    for (const name of SHARED) {
      if (token(POPUP_LIGHT, name) !== resolve(name, APP_LIGHT)) drift.push(`${name} light: ${token(POPUP_LIGHT, name)} != ${resolve(name, APP_LIGHT)}`)
      if (token(POPUP_DARK, name) !== resolve(name, APP_DARK)) drift.push(`${name} dark: ${token(POPUP_DARK, name)} != ${resolve(name, APP_DARK)}`)
    }
    expect(drift).toEqual([])
  })

  it("re-declares every token under the dark scheme, so the OS decides", () => {
    for (const name of SHARED) {
      expect(POPUP_DARK.has(name), `${name} has no dark value`).toBe(true)
    }
  })
})

describe("A1: every colour pair clears WCAG AA", () => {
  const text: Array<[string, string, string]> = [
    ["foreground on background", "--foreground", "--background"],
    ["muted-foreground on background", "--muted-foreground", "--background"],
    ["foreground on muted", "--foreground", "--muted"],
    ["muted-foreground on muted (badge, progress)", "--muted-foreground", "--muted"],
    ["primary-foreground on primary", "--primary-foreground", "--primary"],
  ]
  const nonText: Array<[string, string, string]> = [
    ["ring on background", "--ring", "--background"],
    ["field-edge on background", "--field-edge", "--background"],
    ["success-text on muted", "--success-text", "--muted"],
    ["warning-text on muted", "--warning-text", "--muted"],
    ["destructive-text on muted", "--destructive-text", "--muted"],
  ]

  it("clears 4.5:1 for text", () => {
    const failures: string[] = []
    for (const [label, one, other] of text) {
      const light = contrast(token(POPUP_LIGHT, one), token(POPUP_LIGHT, other))
      const dark = contrast(token(POPUP_DARK, one), token(POPUP_DARK, other))
      if (light < 4.5) failures.push(`${label} light ${light.toFixed(2)}`)
      if (dark < 4.5) failures.push(`${label} dark ${dark.toFixed(2)}`)
    }
    expect(failures).toEqual([])
  })

  it("clears 3:1 for a control edge, a focus ring and a status icon", () => {
    const failures: string[] = []
    for (const [label, one, other] of nonText) {
      const light = contrast(token(POPUP_LIGHT, one), token(POPUP_LIGHT, other))
      const dark = contrast(token(POPUP_DARK, one), token(POPUP_DARK, other))
      if (light < 3) failures.push(`${label} light ${light.toFixed(2)}`)
      if (dark < 3) failures.push(`${label} dark ${dark.toFixed(2)}`)
    }
    expect(failures).toEqual([])
  })

  it("reproduces the measured pair rather than trusting the table", () => {
    // A converter that is wrong in both directions would pass a threshold and fail this.
    expect(contrast(token(POPUP_LIGHT, "--foreground"), token(POPUP_LIGHT, "--background"))).toBeCloseTo(18.1, 1)
    expect(contrast(token(POPUP_LIGHT, "--primary-foreground"), token(POPUP_LIGHT, "--primary"))).toBeCloseTo(5.31, 1)
    expect(contrast(token(POPUP_LIGHT, "--field-edge"), token(POPUP_LIGHT, "--background"))).toBeCloseTo(3.36, 1)
    expect(contrast(token(POPUP_DARK, "--foreground"), token(POPUP_DARK, "--background"))).toBeCloseTo(16.39, 1)
    expect(contrast(token(POPUP_DARK, "--muted-foreground"), token(POPUP_DARK, "--muted"))).toBeCloseTo(6.39, 1)
  })
})

describe("A1: the stylesheet stays inside the type scale and the review contract", () => {
  it("declares no font size below 12.5px", () => {
    const failures: string[] = []
    for (const match of CSS.matchAll(/font-size:\s*([\d.]+)(rem|px)/g)) {
      const value = Number(match[1])
      const px = match[2] === "rem" ? value * 16 : value
      if (px < 12.5) failures.push(`${match[0]}`)
    }
    expect(failures).toEqual([])
  })

  it("puts no colour literal in the stylesheet outside OKLCH", () => {
    // The one deliberate exception is `transparent`.
    expect(/#[0-9a-f]{3,8}\b/i.test(CSS)).toBe(false)
    expect(/\brgba?\(/i.test(CSS)).toBe(false)
    expect(/\bhsla?\(/i.test(CSS)).toBe(false)
  })

  it("gives the review list no box, no inner scroll and no line clamp", () => {
    const rules = [...CSS.matchAll(/#review-values[^{]*\{([^}]*)\}/g)].map((match) => match[1] ?? "")
    expect(rules.length).toBeGreaterThan(0)
    for (const body of rules) {
      expect(body).not.toContain("max-height")
      expect(body).not.toContain("overflow")
      expect(body).not.toContain("-webkit-line-clamp")
      expect(body).not.toContain("border-radius: 6px")
    }
  })

  it("replaces the browser ring with a 2px focus-visible outline", () => {
    const focus = [...CSS.matchAll(/[^{]*:focus-visible[^{]*\{([^}]*)\}/g)].map((match) => match[1] ?? "")
    expect(focus.length).toBeGreaterThan(0)
    for (const body of focus) {
      expect(body).toContain("outline: 2px solid var(--ring)")
      expect(body).not.toMatch(/outline:\s*none/)
    }
  })

  it("keeps every transition and animation behind reduced-motion: no-preference", () => {
    const media = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{([\s\S]*)\}\s*$/.exec(CSS)
    expect(media, "no prefers-reduced-motion block").not.toBeNull()
    const outside = CSS.replace(media?.[0] ?? "", "")
    expect(outside).not.toMatch(/[\s;{]transition:/)
    expect(outside).not.toMatch(/[\s;{]animation:/)
  })
})

describe("A1: the markup keeps the progress line out of the live region", () => {
  const parsed = new DOMParser().parseFromString(HTML, "text/html")

  it("announces through one live region and not through the status panel", () => {
    const announce = parsed.getElementById("announce")
    expect(announce?.getAttribute("role")).toBe("status")
    expect(announce?.getAttribute("aria-live")).toBe("polite")
    expect(announce?.className).toContain("sr-only")
    const status = parsed.getElementById("status")
    expect(status?.getAttribute("role")).toBeNull()
    expect(status?.getAttribute("aria-live")).toBeNull()
    const progressText = parsed.getElementById("progress-text")
    expect(progressText).not.toBeNull()
    expect(progressText?.closest("[aria-live]")).toBeNull()
    expect(parsed.getElementById("progress")?.closest("[aria-live]")).toBeNull()
  })

  it("names the progress bar from the line beside it", () => {
    expect(parsed.getElementById("progress")?.getAttribute("aria-labelledby")).toBe("progress-text")
  })

  it("reveals a sensitive value from a native button, not from script alone", () => {
    // The button is built per row by popup.ts; the markup must at least have the class rule and the label.
    expect(CSS).toContain(".btn-reveal")
    expect(parsed.getElementById("review-values")).not.toBeNull()
  })
})

describe("D1, D9 and D11: the stylesheet keeps one outline shape, a forced-colours block and rem icons", () => {
  /** Every rule whose selector list names `#fill`. */
  const fillRules = [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .map((match) => ({ selector: (match[1] ?? "").trim(), body: match[2] ?? "" }))
    .filter((rule) => /#fill\b/.test(rule.selector))

  it("D1: #fill carries no background, border or colour of its own", () => {
    const offenders = fillRules
      .filter((rule) => /(^|[;{\s])(background|border|color)\s*:/.test(rule.body))
      .map((rule) => rule.selector)
    expect(offenders).toEqual([])
    // No outline override or hover rule layers under the class.
    expect(fillRules.map((rule) => rule.selector)).toEqual(["#fill"])
    expect(CSS).not.toContain("#fill.is-outline")
    expect(CSS).not.toContain("#fill:hover")
  })

  it("D9: a filled button keeps a transparent edge, so its box matches an outline one", () => {
    const primary = block(CSS, /\.btn-primary\s*\{([^}]*)\}/)
    expect(primary).toContain("border: 1px solid transparent")
    const outline = block(CSS, /\.btn-outline\s*\{([^}]*)\}/)
    expect(outline).toContain("border: 1px solid var(--field-edge)")
  })

  it("D9: forced colours says the progress and the disabled state in system colours", () => {
    const forced = block(CSS, /@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*)\n\}/)
    expect(forced).toContain("border: 1px solid ButtonText")
    expect(forced).toContain("background: Canvas")
    expect(forced).toContain("background: Highlight")
    expect(forced).toContain("forced-color-adjust: none")
    expect(forced).toContain("opacity: 1")
    expect(forced).toContain("GrayText")
  })

  it("D2: [hidden] wins over a panel that is a flex container", () => {
    expect(block(CSS, /\[hidden\]\s*\{([^}]*)\}/)).toContain("display: none !important")
  })

  it("D6: the row icon draws an outline of its own, because it sits outside the sprite", () => {
    const rule = block(CSS, /\.row-icon\s*\{([^}]*)\}/)
    for (const declaration of ["fill: none", "stroke: currentColor", "stroke-width: 1.5", "stroke-linecap: round", "stroke-linejoin: round"]) {
      expect(rule).toContain(declaration)
    }
  })

  it("B6: the connection line wraps a long address without splitting a short host, and keeps Change with its dot", () => {
    const line = block(CSS, /#connection\s*\{([^}]*)\}/)
    expect(line).toContain("overflow-wrap: break-word")
    expect(line).not.toContain("display: flex")
    expect(block(CSS, /#connection-tail\s*\{([^}]*)\}/)).toContain("white-space: nowrap")
    expect(HTML).toMatch(/<span id="connection-tail"[^>]*>[^]*<button id="change"[^]*<\/button><\/span>/)
  })

  it("B7: a button keeps block padding, so a label is off the edges when the text scales", () => {
    expect(block(CSS, /\nbutton\s*\{([^}]*)\}/)).toContain("padding: 0.5rem 16px")
  })

  it("D11: both icons are sized in rem, so they follow the font setting", () => {
    for (const selector of ["#status-icon", ".row-icon"]) {
      const rule = block(CSS, new RegExp(`${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`))
      expect(rule, `${selector} rule`).toContain("width: 1rem")
      expect(rule).toContain("height: 1rem")
    }
    expect(block(CSS, /#status-icon\s*\{([^}]*)\}/)).toContain("margin-top: 0.125rem")
  })

  it("D11: the row icon is centred on its row's first line, in rem, so it stays centred when text scales", () => {
    // The row's line box is 1.45 × 0.8125rem; the icon is 1rem; half the difference is the offset.
    expect(block(CSS, /\.row-icon\s*\{([^}]*)\}/)).toContain("margin-top: calc((1.45 * 0.8125rem - 1rem) / 2)")
    const row = block(CSS, /#result-lines li\s*\{([^}]*)\}/)
    expect(row).toContain("font-size: 0.8125rem")
    expect(row).toContain("line-height: 1.45")
  })
})

describe("A1: the manifest declares toolbar icons, and every one is a real PNG of its size", () => {
  interface Manifest {
    icons?: Record<string, string>
    action?: { default_icon?: Record<string, string> }
  }

  const MANIFEST = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")) as Manifest
  const SIZES = ["16", "32", "48", "128"]
  const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

  /**
   * The edge of the PNG, not its dimensions. Chrome draws the default letter tile
   * when the manifest names no icon, and a wrong-size or renamed file fails silently.
   */
  function iconWidth(path: string): number {
    const bytes = readFileSync(join(EXTENSION, path))
    if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) throw new Error(`${path} is not a PNG`)
    // IHDR is the first chunk: 8 signature bytes, 4 length, 4 type, then width and height.
    const width = bytes.readUInt32BE(16)
    const height = bytes.readUInt32BE(20)
    if (width !== height) throw new Error(`${path} is ${width}x${height}, not square`)
    return width
  }

  it("declares 16, 32, 48 and 128 in the top-level icons", () => {
    expect(Object.keys(MANIFEST.icons ?? {}).sort((one, other) => Number(one) - Number(other))).toEqual(SIZES)
  })

  it("action.default_icon maps the same four sizes to the same four paths", () => {
    const declared = MANIFEST.icons ?? {}
    const action = MANIFEST.action?.default_icon ?? {}
    expect(Object.keys(action).sort((one, other) => Number(one) - Number(other))).toEqual(SIZES)
    expect(action).toEqual(declared)
  })

  it("ships each declared icon as a PNG of exactly the declared width and height", () => {
    for (const [size, path] of Object.entries(MANIFEST.icons ?? {})) {
      expect(iconWidth(path), `${path} is not ${size}px`).toBe(Number(size))
    }
  })

  it("fails on a declared icon whose file is missing, so a rename cannot pass unnoticed", () => {
    expect(() => iconWidth("icons/icon16-not-here.png")).toThrow()
  })
})

describe("A1: the popup width is fixed px, because vw is circular in an action popup", () => {
  const body = block(CSS, /\nbody\s*\{([^}]*)\}/)
  // The body's one comment explains the vw trap and names vw, so scan declarations only.
  const declared = body.replace(/\/\*[\s\S]*?\*\//g, "")

  it("sets the body width in px, never in vw and never through min()", () => {
    // In an action popup the viewport is sized from the content, so 100vw resolved to the
    // popup's tiny initial width and the body collapsed to ~145px, one text fragment per
    // line. A harness that opens popup.html as a tab with a fixed viewport cannot see that.
    const width = /(?:^|;)\s*width:\s*([^;]+);/.exec(declared)?.[1]?.trim()
    expect(width).toBe("480px")
    expect(declared).not.toContain("vw")
    expect(declared).not.toContain("min(")
  })
})
