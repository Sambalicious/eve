import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The page filler installs itself on `globalThis`; importing it is the whole setup.
import "./page.js"

// vitest runs from the package root (`apps/extension`).
const EXTENSION = process.cwd()
const SRC = `${join(EXTENSION, "src")}/`

function page(): EvePageApi {
  const api = (globalThis as unknown as { __evePage?: EvePageApi }).__evePage
  if (api === undefined) throw new Error("page.js did not install __evePage")
  return api
}

/** jsdom has no DataTransfer: the filler only needs the FileList a real selection would produce. */
class StubDataTransfer {
  readonly files: File[] = []
  readonly items = { add: (file: File) => this.files.push(file) }
}

function acceptFiles(input: HTMLInputElement): void {
  let files: FileList | null = null
  Object.defineProperty(input, "files", {
    configurable: true,
    get: () => files,
    set: (value: FileList | null) => {
      files = value
    },
  })
}

const FIXTURE = `
  <form id="application" action="https://employer.example/submit">
    <label for="name">Full name</label>
    <input id="name" name="name" required />
    <label for="keep">Keep me posted</label>
    <input type="checkbox" id="keep" name="keep" />
    <fieldset>
      <legend>Remote</legend>
      <label><input type="radio" name="remote" value="yes" />Yes</label>
      <label><input type="radio" name="remote" value="no" />No</label>
    </fieldset>
    <label for="cv">Resume</label>
    <input type="file" id="cv" name="resume" accept=".pdf" />
    <button type="submit" id="send">Submit application</button>
    <a href="https://employer.example/terms" id="terms">Terms</a>
  </form>
`

beforeEach(() => {
  document.body.innerHTML = FIXTURE
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("G1: a filled form is never submitted, navigated or given a chooser", () => {
  it("runs the whole stepped sequence without any click on a file, a submit or a link", async () => {
    const clicked: Element[] = []
    const inputClick = HTMLInputElement.prototype.click
    vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      clicked.push(this)
      inputClick.call(this)
    })
    vi.spyOn(HTMLButtonElement.prototype, "click").mockImplementation(function (this: HTMLButtonElement) {
      clicked.push(this)
    })
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this)
    })

    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, "requestSubmit")
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit")
    const showPicker = vi.fn()
    Object.defineProperty(HTMLInputElement.prototype, "showPicker", { configurable: true, value: showPicker })
    const open = vi.spyOn(window, "open").mockImplementation(() => null)
    const submitted = vi.fn()
    const form = document.getElementById("application") as HTMLFormElement
    form.addEventListener("submit", submitted)

    const hrefBefore = window.location.href
    vi.stubGlobal("DataTransfer", StubDataTransfer)
    const file = document.getElementById("cv") as HTMLInputElement
    acceptFiles(file)

    page().read()
    page().begin()
    expect(await page().fillValue({ ref: "f0", value: "Ada", kind: "text" })).toBe(true)
    expect(await page().fillValue({ ref: "f1", value: "yes", kind: "checkbox" })).toBe(true)
    expect(await page().fillValue({ ref: "r2", value: "No", kind: "radio" })).toBe(true)
    expect(
      await page().attachFile({ ref: "f3", name: "Ada Okafor - Resume.pdf", type: "application/pdf", base64: btoa("resume bytes") })
    ).toBe(true)
    page().finish()

    // The only clicks the filler is allowed: the two controls whose state a click is the selection.
    expect(clicked.length).toBeGreaterThan(0)
    for (const element of clicked) {
      const tag = element.tagName.toLowerCase()
      const type = element.getAttribute("type")
      expect(tag).toBe("input")
      expect(type === "checkbox" || type === "radio").toBe(true)
      expect(element.id === "keep" || element.getAttribute("name") === "remote").toBe(true)
    }
    expect(clicked.some((element) => element.id === "send")).toBe(false)
    expect(clicked.some((element) => element.id === "terms")).toBe(false)
    expect(clicked.some((element) => element.id === "cv")).toBe(false)

    expect(requestSubmit).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(showPicker).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(submitted).not.toHaveBeenCalled()
    expect(window.location.href).toBe(hrefBefore)
  })
})

describe("G2: the source has no way to submit, download, choose a file or reach a network", () => {
  function sourceFiles(): string[] {
    return readdirSync(SRC)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts"))
      .map((name) => `${SRC}${name}`)
  }

  function scanned(): Array<{ name: string; text: string }> {
    const files = [
      ...sourceFiles().map((path) => ({ name: path.slice(SRC.length), text: readFileSync(path, "utf8") })),
      { name: "popup.html", text: readFileSync(`${SRC}popup.html`, "utf8") },
      { name: "popup.css", text: readFileSync(`${SRC}popup.css`, "utf8") },
      { name: "manifest.json", text: readFileSync(join(EXTENSION, "manifest.json"), "utf8") },
    ]
    return files
  }

  it("has none of the primitives a fill must never use", () => {
    const forbidden: Array<[RegExp, string]> = [
      [/requestSubmit/, "requestSubmit"],
      [/\.submit\s*\(/, ".submit("],
      [/showPicker/, "showPicker"],
      [/showOpenFilePicker/, "showOpenFilePicker"],
      [/window\.open/, "window.open"],
      [/chrome\.downloads/, "chrome.downloads"],
      [/chrome\.sidePanel/, "chrome.sidePanel"],
      [/XMLHttpRequest/, "XMLHttpRequest"],
      [/WebSocket/, "WebSocket"],
      [/sendBeacon/, "sendBeacon"],
      [/EventSource/, "EventSource"],
    ]
    const found: string[] = []
    for (const { name, text } of scanned()) {
      for (const [pattern, label] of forbidden) if (pattern.test(text)) found.push(`${name}: ${label}`)
    }
    expect(found).toEqual([])
  })

  it("clicks only the two checkbox/radio sites in page.ts", () => {
    const found: string[] = []
    for (const { name, text } of scanned()) {
      const calls = text.split(".click(").length - 1
      const allowed = name === "page.ts" ? 2 : 0
      if (calls !== allowed) found.push(`${name}: ${calls} .click( call(s), expected ${allowed}`)
    }
    expect(found).toEqual([])
  })

  it("names no language model and calls no network primitive but the bridge's fetch", () => {
    const found: string[] = []
    for (const { name, text } of scanned()) {
      if (/openai|anthropic|claude|gemini|\bllm\b|gpt-|completion|embedding/i.test(text)) found.push(`${name}: names a language model`)
      const fetches = text.split("fetch(").length - 1
      if (name !== "eve-bridge.ts" && fetches > 0) found.push(`${name}: ${fetches} fetch( call(s) outside the bridge`)
    }
    expect(found).toEqual([])
  })

  it("asks for no host permission beyond the two optional patterns", () => {
    const manifest = JSON.parse(readFileSync(join(EXTENSION, "manifest.json"), "utf8")) as {
      permissions?: string[]
      optional_host_permissions?: string[]
      host_permissions?: string[]
    }
    expect(manifest.permissions).toEqual(["activeTab", "scripting", "storage"])
    expect(manifest.host_permissions).toBeUndefined()
    expect(manifest.optional_host_permissions).toEqual(["http://*/*", "https://*/*"])
  })
})
