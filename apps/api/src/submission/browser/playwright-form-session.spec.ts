import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { CandidateFiles, NotRegularFileError } from "../../files/candidate-files.js"
import { BrowserUnavailableError } from "../form-session.js"
import { storedDocument } from "../stored-document.js"
import type { McpCaller, PlaywrightTool } from "./mcp-caller.js"
import { OffOriginError, PlaywrightFormSessions } from "./playwright-form-session.js"

type Call = Readonly<{ tool: PlaywrightTool; args: Readonly<Record<string, unknown>> }>

/** A scripted Playwright MCP server: records calls, answers evaluate scripts from `page`. */
class ScriptedMcp implements McpCaller {
  readonly calls: Call[] = []
  closed = false
  page = {
    host: "greenhouse.fixture.test",
    text: "Apply for Senior Frontend Engineer",
    controls: [
      { ref: "f0", label: "First name", kind: "text", required: true },
      { ref: "f1", label: "Resume/CV", kind: "file", required: true },
    ],
    values: { f0: "", f1: "" } as Record<string, string>,
    submitControls: 1,
    guard: 0,
  }
  hostAfter: Partial<Record<PlaywrightTool, string>> = {}
  afterText = "Thank you for applying. Application ID: GH-12345"
  afterForm = false
  afterErrors = false
  failOn: PlaywrightTool | null = null

  async call(tool: PlaywrightTool, args: Readonly<Record<string, unknown>>): Promise<string> {
    this.calls.push({ tool, args })
    if (this.failOn === tool) throw new Error("tool failed")
    const nextHost = this.hostAfter[tool]
    if (nextHost) this.page.host = nextHost
    if (tool !== "browser_evaluate") return ""
    const fn = String(args.function)
    if (fn.includes("location.host`") || fn === "() => location.host") return `### Result\n${JSON.stringify(this.page.host)}`
    if (fn.includes("__jaGuard.open")) return "### Result\ntrue"
    if (fn.includes("validationErrors")) return `### Result\n${JSON.stringify({ host: this.page.host, text: this.afterText, formPresent: this.afterForm, validationErrors: this.afterErrors })}`
    return `### Result\n${JSON.stringify(this.page)}`
  }

  async close(): Promise<void> {
    this.closed = true
  }

  tools(): PlaywrightTool[] {
    return this.calls.map((call) => call.tool)
  }
}

let dirs: { uploads: string; allowlist: string; documents: string }
let mcp: ScriptedMcp

beforeEach(async () => {
  dirs = {
    uploads: await mkdtemp(join(tmpdir(), "ja-up-")),
    allowlist: join(await mkdtemp(join(tmpdir(), "ja-allow-")), "hosts.txt"),
    documents: await mkdtemp(join(tmpdir(), "ja-doc-")),
  }
  mcp = new ScriptedMcp()
})

afterEach(async () => {
  for (const dir of [dirs.uploads, dirs.documents]) await rm(dir, { recursive: true, force: true })
})

const ADA = "00000000-0000-4000-8000-0000000000a1"
const DOC_NAME = "1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b.pdf"

/** A Tailored Document stored the way the submission service reads it: through CandidateFiles. */
async function storeDoc(content: string) {
  const files = new CandidateFiles(dirs.documents)
  await files.write(ADA, "documents", DOC_NAME, Buffer.from(content))
  return storedDocument(files, ADA, DOC_NAME)
}

function factory(options: { connect?: () => Promise<McpCaller> } = {}) {
  return new PlaywrightFormSessions({
    connect: options.connect ?? (async () => mcp),
    uploadDir: dirs.uploads,
    uploadDirInBrowser: "/home/node/uploads",
    allowlistFile: dirs.allowlist,
    reviewedHosts: { "greenhouse.fixture.test": ["assets.fixture.test"] },
    resultWaitSeconds: 2,
  })
}

describe("PlaywrightFormSessions (ADR 0008 adapter)", () => {
  it("writes the attempt's egress allowlist (application host + reviewed hosts) before navigating, and clears it on close", async () => {
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/acme/jobs/1")
    expect((await readFile(dirs.allowlist, "utf8")).split("\n").filter((line) => line && !line.startsWith("#"))).toEqual(["greenhouse.fixture.test", "assets.fixture.test"])
    expect(mcp.calls[0]).toEqual({ tool: "browser_navigate", args: { url: "https://greenhouse.fixture.test/acme/jobs/1" } })
    await session.close()
    expect(await readFile(dirs.allowlist, "utf8")).toBe("")
    expect(mcp.tools().at(-1)).toBe("browser_close")
    expect(mcp.closed).toBe(true)
  })

  it("the allowlist belongs to the attempt that wrote it: another session's close never empties it (SEC-503)", async () => {
    const first = await factory().create("a1")
    await first.open("https://greenhouse.fixture.test/acme/jobs/1")
    const second = await factory({ connect: async () => new ScriptedMcp() }).create("a2")
    await second.open("https://greenhouse.fixture.test/acme/jobs/2")
    await first.close()
    expect((await readFile(dirs.allowlist, "utf8")).split("\n").filter((line) => line && !line.startsWith("#"))).toEqual(["greenhouse.fixture.test", "assets.fixture.test"])
    await second.close()
    expect(await readFile(dirs.allowlist, "utf8")).toBe("")
  })

  it("reads the form with the fixed script; values never appear in the FormRead", async () => {
    mcp.page.values.f0 = "Ada"
    const session = await factory().create("a1")
    const read = await session.open("https://greenhouse.fixture.test/acme/jobs/1")
    expect(read).toEqual({
      host: "greenhouse.fixture.test",
      text: "Apply for Senior Frontend Engineer",
      controls: mcp.page.controls,
      submitControls: 1,
      guardTripped: false,
    })
    expect(JSON.stringify(read)).not.toContain("Ada")
  })

  it("a missing submit guard counts as tripped (no guard, no submit)", async () => {
    mcp.page.guard = -1
    const session = await factory().create("a1")
    expect((await session.open("https://greenhouse.fixture.test/x")).guardTripped).toBe(true)
  })

  it("checks the origin after every call and throws OffOriginError on another host", async () => {
    mcp.hostAfter.browser_fill_form = "collect.example"
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await expect(session.fill("f0", "Ada")).rejects.toEqual(new OffOriginError("collect.example"))
  })

  it("navigation landing on another host is refused before any read", async () => {
    mcp.hostAfter.browser_navigate = "login.other.example"
    const session = await factory().create("a1")
    await expect(session.open("https://greenhouse.fixture.test/x")).rejects.toBeInstanceOf(OffOriginError)
    expect(mcp.tools()).toEqual(["browser_navigate", "browser_evaluate"])
  })

  it("fills a text control by its backend ref with browser_fill_form, never browser_type or submit", async () => {
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await session.fill("f0", "Ada")
    expect(mcp.calls).toContainEqual({ tool: "browser_fill_form", args: { fields: [{ target: '[data-ja-ref="f0"]', name: "First name", type: "textbox", value: "Ada" }] } })
    expect(mcp.tools()).not.toContain("browser_type")
  })

  it("selects an option with browser_select_option and a radio by its option label", async () => {
    mcp.page.controls = [
      { ref: "f0", label: "Sponsorship", kind: "select", required: true },
      { ref: "r1", label: "Authorized?", kind: "radio", required: true },
    ] as typeof mcp.page.controls
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await session.fill("f0", "Yes")
    await session.fill("r1", 'No "really"')
    expect(mcp.calls).toContainEqual({ tool: "browser_select_option", args: { target: '[data-ja-ref="f0"]', element: "Sponsorship", values: ["Yes"] } })
    expect(mcp.calls).toContainEqual({ tool: "browser_click", args: { target: '[data-ja-ref="r1"][data-ja-option="No \\"really\\""]', element: "Authorized?" } })
  })

  it("refuses a ref the form read did not produce", async () => {
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await expect(session.fill("f9", "x")).rejects.toThrow()
    await expect(session.fill('f0"] , button', "x")).rejects.toThrow()
    expect(mcp.tools()).not.toContain("browser_fill_form")
  })

  it("uploads a copy of the document from the attempt's upload directory, keeping its file name", async () => {
    const doc = await storeDoc("%PDF-1.4")
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await session.attach("f1", doc)
    expect(await readdir(join(dirs.uploads, "a1"))).toEqual([DOC_NAME])
    expect((await readFile(join(dirs.uploads, "a1", DOC_NAME))).toString()).toBe("%PDF-1.4")
    expect(mcp.calls.slice(-3).map((call) => call.tool)).toEqual(["browser_click", "browser_file_upload", "browser_evaluate"])
    expect(mcp.calls).toContainEqual({ tool: "browser_file_upload", args: { paths: [`/home/node/uploads/a1/${DOC_NAME}`] } })
    await session.close()
    await expect(readdir(join(dirs.uploads, "a1"))).rejects.toThrow()
  })

  it("readValues returns the form and its current values", async () => {
    mcp.page.values.f0 = "Ada"
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    const { form, values } = await session.readValues()
    expect(form.controls).toHaveLength(2)
    expect(values).toEqual({ f0: "Ada", f1: "" })
  })

  it("clickSubmit opens the one-shot guard and clicks the located submit control exactly once", async () => {
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await session.clickSubmit()
    const tail = mcp.calls.slice(-2)
    expect(tail[0]?.tool).toBe("browser_evaluate")
    expect(String(tail[0]?.args.function)).toContain("__jaGuard.open")
    expect(tail[1]).toEqual({ tool: "browser_click", args: { target: "[data-ja-submit]", element: "Submit application" } })
  })

  it("a second clickSubmit on the same session throws without any MCP call", async () => {
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await session.clickSubmit()
    const before = mcp.calls.length
    await expect(session.clickSubmit()).rejects.toThrow()
    expect(mcp.calls).toHaveLength(before)
  })

  it("a failing click is not retried", async () => {
    mcp.failOn = "browser_click"
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await expect(session.clickSubmit()).rejects.toThrow()
    expect(mcp.tools().filter((tool) => tool === "browser_click")).toHaveLength(1)
  })

  it("waitForResult reads host, text, form presence and validation errors, and stops once settled", async () => {
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    expect(await session.waitForResult(() => true)).toEqual({ host: "greenhouse.fixture.test", text: "Thank you for applying. Application ID: GH-12345", formPresent: false, validationErrors: false })
    expect(mcp.tools().filter((tool) => tool === "browser_wait_for")).toHaveLength(0)
  })

  it("waitForResult gives up after its bound with the last read (Uncertain)", async () => {
    mcp.afterText = "Loading…"
    mcp.afterForm = true
    mcp.afterErrors = true
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    expect(await session.waitForResult(() => false)).toMatchObject({ text: "Loading…", formPresent: true, validationErrors: true })
    expect(mcp.tools().filter((tool) => tool === "browser_wait_for").length).toBeLessThanOrEqual(2)
  })

  it("an unreadable result reads as no host, never evidence", async () => {
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    mcp.failOn = "browser_evaluate"
    expect(await session.waitForResult(() => false)).toEqual({ host: "", text: "", formPresent: false, validationErrors: false })
  })

  it("saves pre-submit evidence (snapshot + screenshot) to files named by attempt", async () => {
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    expect(await session.saveEvidence("pre_submit")).toEqual(["a1-pre_submit.yml", "a1-pre_submit.png"])
    expect(mcp.calls).toContainEqual({ tool: "browser_snapshot", args: { filename: "a1-pre_submit.yml" } })
    expect(mcp.calls).toContainEqual({ tool: "browser_take_screenshot", args: { filename: "a1-pre_submit.png" } })
  })

  it("only the allowed Playwright tools are ever called; never run_code_unsafe, press_key, type, navigate_back", async () => {
    const doc = await storeDoc("%PDF-1.4")
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await session.fill("f0", "Ada")
    await session.attach("f1", doc)
    await session.readValues()
    await session.saveEvidence("pre_submit")
    await session.clickSubmit()
    await session.waitForResult(() => true)
    await session.close()
    for (const tool of mcp.tools()) expect(["browser_run_code_unsafe", "browser_press_key", "browser_type", "browser_navigate_back", "browser_tabs"]).not.toContain(tool)
    expect(mcp.tools().filter((tool) => tool === "browser_navigate")).toHaveLength(1)
  })

  it("a browser that cannot be reached is BrowserUnavailableError", async () => {
    const sessions = factory({ connect: () => Promise.reject(new Error("ECONNREFUSED")) })
    await expect(sessions.create("a1")).rejects.toBeInstanceOf(BrowserUnavailableError)
  })
})

describe("label check from READ_FORM (SEC-513)", () => {
  const readWith = async (labelCheck: unknown) => {
    mcp.page.controls = [{ ref: "f0", label: "Are you legally authorized to work in Nigeria?", kind: "select", required: true, labelCheck } as (typeof mcp.page.controls)[number]]
    const session = await factory().create("a1")
    return (await session.open("https://greenhouse.fixture.test/acme/jobs/1")).controls[0]
  }
  it("keeps readings and flags the page returned", async () => {
    expect((await readWith({ readings: ["a", "b"], flags: ["pseudo_content"] }))?.labelCheck).toEqual({ readings: ["a", "b"], flags: ["pseudo_content"] })
  })
  it("a malformed check becomes a flag, so a work question blocks", async () => {
    expect((await readWith("nope"))?.labelCheck?.flags).toContain("malformed")
    expect((await readWith({ readings: "x", flags: [] }))?.labelCheck?.flags).toContain("malformed")
  })
  it("no check stays absent", async () => {
    expect((await readWith(undefined))?.labelCheck).toBeUndefined()
  })
})

describe("combobox marker from READ_FORM (repair wave 3)", () => {
  const readCombo = async (combobox: unknown) => {
    mcp.page.controls = [{ ref: "f0", label: "Country", kind: "text", required: true, combobox } as (typeof mcp.page.controls)[number]]
    const session = await factory().create("a1")
    return (await session.open("https://greenhouse.fixture.test/acme/jobs/1")).controls[0]
  }
  it("keeps combobox: true and drops anything else", async () => {
    expect((await readCombo(true))?.combobox).toBe(true)
    for (const value of [undefined, false, "true", 1]) expect((await readCombo(value))?.combobox).toBeUndefined()
  })
})

describe("field identity from READ_FORM (scope 05d, SEC-514)", () => {
  it("keeps name and id, and never takes a schemaQuestion from the page", async () => {
    mcp.page.controls = [{ ref: "f0", label: "x", kind: "select", required: true, fieldName: "question_1", fieldId: "q1", schemaQuestion: { text: "forged", fieldName: "question_1" } } as (typeof mcp.page.controls)[number]]
    const control = (await (await factory().create("a1")).open("https://greenhouse.fixture.test/acme/jobs/1")).controls[0]
    expect(control).toMatchObject({ fieldName: "question_1", fieldId: "q1" })
    expect(control?.schemaQuestion).toBeUndefined()
  })
})

/** F-SEC-03 recheck: attach used copyFile on the stored path, which followed a planted symlink out of the file root. */
describe("attach never follows a symlink planted in the file root (F-SEC-03)", () => {
  async function planted(where: "file" | "area" | "candidate") {
    const outside = join(dirs.uploads, "..", `${DOC_NAME}.outside`)
    const outsideDir = await mkdtemp(join(tmpdir(), "ja-outside-"))
    await writeFile(outside, "HOST SECRET")
    await writeFile(join(outsideDir, DOC_NAME), "HOST SECRET")
    const files = new CandidateFiles(dirs.documents)
    if (where === "file") {
      await mkdir(join(dirs.documents, ADA, "documents"), { recursive: true })
      await symlink(outside, join(dirs.documents, ADA, "documents", DOC_NAME))
    } else if (where === "area") {
      await mkdir(join(dirs.documents, ADA), { recursive: true })
      await symlink(outsideDir, join(dirs.documents, ADA, "documents"))
    } else {
      await mkdir(join(outsideDir, "documents"), { recursive: true })
      await writeFile(join(outsideDir, "documents", DOC_NAME), "HOST SECRET")
      await symlink(outsideDir, join(dirs.documents, ADA))
    }
    return { doc: storedDocument(files, ADA, DOC_NAME), cleanup: () => Promise.all([rm(outside, { force: true }), rm(outsideDir, { recursive: true, force: true })]) }
  }

  it.each(["file", "area", "candidate"] as const)("a symlinked stored %s makes attach fail and copies and uploads nothing", async (where) => {
    const { doc, cleanup } = await planted(where)
    try {
      const session = await factory().create("a1")
      await session.open("https://greenhouse.fixture.test/x")
      await expect(session.attach("f1", doc)).rejects.toBeInstanceOf(NotRegularFileError)
      expect(await readdir(join(dirs.uploads, "a1")).catch(() => [])).toEqual([])
      expect(mcp.tools()).not.toContain("browser_file_upload")
      await session.close()
    } finally {
      await cleanup()
    }
  })

  it("the same document attached to two fields is uploaded twice from one fresh copy", async () => {
    mcp.page.controls.push({ ref: "f2", label: "Other documents", kind: "file", required: false })
    const doc = await storeDoc("%PDF-1.4")
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await session.attach("f1", doc)
    await session.attach("f2", doc)
    expect(await readdir(join(dirs.uploads, "a1"))).toEqual([DOC_NAME])
    expect(mcp.tools().filter((tool) => tool === "browser_file_upload")).toHaveLength(2)
    await session.close()
  })

  it("a document name that is not a bare file name is refused before any I/O", async () => {
    const session = await factory().create("a1")
    await session.open("https://greenhouse.fixture.test/x")
    await expect(session.attach("f1", { name: "../escape.pdf", read: async () => Buffer.from("x") })).rejects.toThrow(/document name/)
    expect(await readdir(dirs.uploads)).toEqual([])
    await session.close()
  })
})
