import { describe, expect, it } from "vitest"

import { type LabelNode, READ_FORM, labelText } from "./form-scripts.js"

/** A minimal element tree with the DOM members `labelText` reads. */
type Attrs = Record<string, string>
const h = (tag: string, attrs: Attrs, ...children: Array<LabelNode | string>): LabelNode => ({
  nodeType: 1,
  tagName: tag.toUpperCase(),
  getAttribute: (name) => attrs[name] ?? null,
  childNodes: children.map((child) => (typeof child === "string" ? { nodeType: 3, nodeValue: child } : child)),
})
const select = () => h("select", { id: "wa" }, h("option", { value: "" }, "Please select"), h("option", {}, "Yes"), h("option", {}, "No"))
const QUESTION = "Are you legally authorized to work in Nigeria?"

// The three label shapes of docker/fake-ats/server.mjs `field()`.
const lever = (label: string) => h("label", {}, h("div", { class: "application-label" }, label), select())
const greenhouse = (label: string) => h("label", { for: "wa" }, label)
const ashby = (label: string) => h("label", { class: "_heading", id: "wa-label" }, label)

describe("labelText (F-QA5E-01)", () => {
  it.each([
    ["Lever (select inside the label)", lever(QUESTION)],
    ["Greenhouse (label for=)", greenhouse(QUESTION)],
    ["Ashby (aria-labelledby heading)", ashby(QUESTION)],
  ])("%s reads only the question text", (_name, node) => {
    expect(labelText(node)).toBe(QUESTION)
  })

  it("skips inputs, textareas, buttons, listbox roles and hidden nodes, and collapses whitespace", () => {
    const node = h(
      "label",
      {},
      "  Are you\n  authorized ",
      h("input", { type: "text", value: "x" }),
      h("textarea", {}, "typed"),
      h("button", {}, "Clear"),
      h("ul", { role: "listbox" }, h("li", { role: "option" }, "Yes")),
      h("span", { "aria-hidden": "true" }, "*"),
      h("span", { hidden: "" }, "Togo"),
      "to work in\tNigeria?"
    )
    expect(labelText(node)).toBe("Are you authorized to work in Nigeria?")
  })

  it("keeps visible text after the control, so nothing the page shows is dropped", () => {
    expect(labelText(h("label", {}, "Are you authorized to work in Nigeria", select(), "and Togo?"))).toBe("Are you authorized to work in Nigeria and Togo?")
  })

  it("an element skipped by checkVisibility adds no text", () => {
    const hidden: LabelNode = { ...h("span", {}, "and Togo"), checkVisibility: () => false }
    expect(labelText(h("label", {}, "Are you authorized to work in Nigeria?", hidden))).toBe("Are you authorized to work in Nigeria?")
  })

  it("an empty or missing element reads as empty", () => {
    expect(labelText(null)).toBe("")
    expect(labelText(h("legend", {}))).toBe("")
  })

  it("READ_FORM uses it for every label source and is still one fixed script", () => {
    expect(READ_FORM).toContain("const labelText = function labelText(")
    expect(READ_FORM).not.toMatch(/return text\((l|wrap|set\.querySelector)/)
    expect(() => new Function(`return (${READ_FORM})`)).not.toThrow()
  })
})

describe("READ_FORM label check (SEC-513)", () => {
  it("returns readings and flags for every control and is still one fixed script", () => {
    expect(READ_FORM).toContain("labelCheck: checkOf(el, false)")
    expect(READ_FORM).toContain("labelCheck: checkOf(el, true)")
    // Scope 05d: name and id for the schema match and the SEC-514 identity check.
    expect(READ_FORM).toContain('fieldName: el.name || "", fieldId: el.id || ""')
    // Repair wave 3: a text input that offers choices is marked, so the agent never fills it.
    expect(READ_FORM).toMatch(/role[\s\S]*combobox[\s\S]*hasAttribute\("list"\)[\s\S]*aria-autocomplete[\s\S]*control\.combobox = true/)
    for (const flag of ["hidden_node", "interactive_role", "nested_control", "shadow", "pseudo_content", "offscreen_source", "aria_override", "opaque_content"]) expect(READ_FORM).toContain(`"${flag}"`)
    expect(() => new Function(`return (${READ_FORM})`)).not.toThrow()
  })
})
