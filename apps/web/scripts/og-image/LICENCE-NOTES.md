# Licence notes: social preview image tooling

`generate.mjs` runs by hand on a developer machine (design-spec.r3-og.md). None of
these packages is imported by `src/`, so none ships in the app bundle; only the
generated `public/og-image.png` is served.

| Package | Version | Licence | Use |
|---|---|---|---|
| `@resvg/resvg-js` | 2.6.2 (exact) | MPL-2.0 | Rasterizes `og-image.svg` to PNG. Dev dependency only. |
| `fontkit` | 2.0.4 (exact) | MIT | Lays out text and outlines glyphs to SVG paths. |
| `wawoff2` | 2.0.1 (exact) | MIT | Decompresses the WOFF2 fonts to TTF for fontkit. |

- **MPL-2.0 (resvg-js).** File-level copyleft: obligations apply only if we
  distribute resvg source files, modified or not, or its binaries. We distribute
  neither; it runs locally and only its output (a PNG) is committed. Do not import
  it from `src/`, a Vite plugin or any build step. `og-image.test.ts` enforces the
  `src/` rule.
- **Fonts.** Bricolage Grotesque and Geist (SIL OFL 1.1, via `@fontsource-variable`)
  are outlined into paths inside the image. That is not a font redistribution, so
  the OFL permits it. The SVG embeds no font data.
- **Icons.** The Eve mark is ours. The `BadgeCheck` path is from Lucide (ISC), the
  same licence as the app's existing `lucide-react` icons.
