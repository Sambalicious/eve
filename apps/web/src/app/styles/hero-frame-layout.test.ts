import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// DR-E3-01 item 1. Below 768px `.hf-body` is a one-column grid. With an implicit
// `auto` column and `min-width: auto` items, the nowrap mail subject set the
// column's min-content width and `.hf { overflow: clip }` cut the right edge.
// jsdom applies the top-level rules (the < 768px path), so they are checked computed.
const css = readFileSync(`${(import.meta as ImportMeta & { dirname: string }).dirname}/landing.css`, "utf8")

function styleOf(className: string) {
  const el = document.createElement("div")
  el.className = className
  document.body.append(el)
  return getComputedStyle(el)
}

describe("hero frame layout below 768px", () => {
  let style: HTMLStyleElement
  beforeAll(() => {
    style = document.createElement("style")
    style.textContent = css
    document.head.append(style)
  })
  afterAll(() => {
    style.remove()
    document.body.replaceChildren()
  })

  it("gives the body one column that can shrink below its content's min-content width", () => {
    expect(styleOf("hf-body").gridTemplateColumns).toBe("minmax(0, 1fr)")
  })

  it("lets blocks, the mail card and columns shrink inside that column", () => {
    expect(styleOf("hf-block").minWidth).toMatch(/^0(px)?$/)
    expect(styleOf("hf-mail").minWidth).toMatch(/^0(px)?$/)
    expect(styleOf("hf-col").minWidth).toMatch(/^0(px)?$/)
  })

  it("wraps long quote text instead of widening the column", () => {
    expect(styleOf("hf-quote").overflowWrap).toBe("anywhere")
  })

  it("keeps the subject on one line with an ellipsis", () => {
    const subject = styleOf("hf-mail-subject")
    expect(subject.whiteSpace).toBe("nowrap")
    expect(subject.textOverflow).toBe("ellipsis")
    expect(subject.overflow).toBe("hidden")
  })
})
