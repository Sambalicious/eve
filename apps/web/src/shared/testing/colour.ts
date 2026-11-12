/**
 * Colour maths for token tests (WCAG 2.x relative luminance). Resolves the
 * subset of CSS colour syntax the token files use: oklch(), var(),
 * color-mix(in srgb, a N%, b), and #rrggbb.
 */
export type Rgb = [number, number, number]

/** OKLCH (L 0-1, C, H degrees, optional alpha over `under`) to sRGB 0-255. */
export function oklchToRgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
  return lin.map((v) => {
    const x = Math.min(1, Math.max(0, v))
    return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055)
  }) as Rgb
}

export const fromHex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb

/** Reads every `--name: value;` in a CSS block body. */
export function readTokens(source: string, into: Record<string, string> = {}): Record<string, string> {
  for (const [, name, value] of source.matchAll(/(--[\w-]+):\s*([^;]+);/g)) into[name] = value.trim()
  return into
}

/** The body of the first top-level rule whose selector is exactly `selector`. */
export function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  if (start < 0) throw new Error(`${selector} block missing`)
  return css.slice(start, css.indexOf("\n}", start))
}

export function resolveColour(value: string, table: Record<string, string>): Rgb {
  const v = value.trim()
  const ref = /^var\((--[\w-]+)\)$/.exec(v)
  if (ref) {
    const next = table[ref[1]]
    if (next === undefined) throw new Error(`${ref[1]} missing`)
    return resolveColour(next, table)
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) return fromHex(v)
  const ok = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(v)
  if (ok) return oklchToRgb(Number(ok[1]), Number(ok[2]), Number(ok[3]))
  const mix = /^color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/.exec(v)
  if (mix) {
    const p = Number(mix[2]) / 100
    const x = resolveColour(mix[1], table)
    const y = resolveColour(mix[3], table)
    return x.map((n, i) => n * p + y[i] * (1 - p)) as Rgb
  }
  throw new Error(`unsupported colour ${v}`)
}

export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((n) => {
    const c = n / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/** `top` at `alpha` composited over `under`. */
export function over(top: Rgb, alpha: number, under: Rgb): Rgb {
  return top.map((n, i) => n * alpha + under[i] * (1 - alpha)) as Rgb
}
