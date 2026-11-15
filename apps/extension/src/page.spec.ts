import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The reader/filler installs itself on `globalThis`; importing it is the whole setup.
import "./page.js"

/** The extension's page API, as the background worker calls it. */
function page(): EvePageApi {
  const api = (globalThis as unknown as { __evePage?: EvePageApi }).__evePage
  if (api === undefined) throw new Error("page.js did not install __evePage")
  return api
}

const FORM = `
  <form>
    <label for="first">First name</label>
    <input id="first" name="first_name" required />

    <span id="email-label">Email address</span>
    <input type="email" aria-labelledby="email-label" name="email" />

    <input aria-label="Phone number" name="phone" />

    <label>Cover letter<textarea name="cover_letter"></textarea></label>

    <label for="office">Office</label>
    <select id="office" name="office">
      <option value="">Choose</option>
      <option>Lagos</option>
      <option>Abuja</option>
    </select>

    <fieldset>
      <legend>Veteran status</legend>
      <label><input type="radio" name="veteran" value="yes" required />Yes</label>
      <label><input type="radio" name="veteran" value="no" />No</label>
    </fieldset>

    <input type="checkbox" name="terms" aria-label="I agree to the terms" />
    <input type="file" name="resume" aria-label="Resume" />
    <input type="password" name="password" aria-label="Password" />
    <input type="hidden" name="token" value="hidden-value" />
    <input aria-label="Read only" readonly value="fixed" />
    <input aria-label="Not shown" style="display: none" />
    <label for="years">Years of experience</label>
    <input id="years" name="years" type="number" />
    <label for="city">City</label>
    <input id="city" name="city" required />
  </form>
`

beforeEach(() => {
  document.body.innerHTML = FORM
})

afterEach(() => {
  // A measurement test may have given the shared body a layout; later tests get jsdom's no-layout document back.
  delete (document.body as unknown as { getClientRects?: () => DOMRectList }).getClientRects
  Object.defineProperty(window, "scrollX", { configurable: true, value: 0 })
  Object.defineProperty(window, "scrollY", { configurable: true, value: 0 })
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 0 })
  vi.unstubAllGlobals()
})

/** jsdom has no DataTransfer: the filler only needs the FileList a real selection would produce. */
class StubDataTransfer {
  readonly files: File[] = []
  readonly items = { add: (file: File) => this.files.push(file) }
}

/** jsdom's `files` is read-only; a file input a page can really accept holds what the filler assigned. */
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

/** jsdom has no layout engine: a test that measures gives the document and its controls a box. */
function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect
}

function place(element: Element, box: DOMRect = rect(0, 0, 200, 24)): void {
  Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => box })
  // A real browser would answer for a laid-out box; jsdom does not implement the layout-aware check.
  Object.defineProperty(element, "checkVisibility", { configurable: true, value: () => true })
}

function showLayout(): void {
  Object.defineProperty(document.body, "getClientRects", { configurable: true, value: () => [rect(0, 0, 1024, 768)] })
}

describe("the page reader (ADR 0016: the extension reads labels with its own copy of the rules)", () => {
  it("reads visible controls with the reader's label precedence and kinds", () => {
    expect(page().read()).toEqual([
      { ref: "f0", label: "First name", kind: "text", required: true },
      { ref: "f1", label: "Email address", kind: "text", required: false },
      { ref: "f2", label: "Phone number", kind: "text", required: false },
      { ref: "f3", label: "Cover letter", kind: "textarea", required: false },
      { ref: "f4", label: "Office", kind: "select", required: false, options: ["Choose", "Lagos", "Abuja"] },
      { ref: "r5", label: "Veteran status", kind: "radio", required: true, options: ["Yes", "No"] },
      { ref: "f6", label: "I agree to the terms", kind: "checkbox", required: false },
      { ref: "f7", label: "Resume", kind: "file", required: false },
      { ref: "f8", label: "Years of experience", kind: "text", required: false },
      { ref: "f9", label: "City", kind: "text", required: true },
    ])
  })

  it("skips password, hidden, read-only and invisible controls, and never sends a value", () => {
    const labels = page().read().map((field) => field.label)
    expect(labels).not.toContain("Password")
    expect(labels).not.toContain("Read only")
    expect(labels).not.toContain("Not shown")
    expect(JSON.stringify(page().read())).not.toContain("hidden-value")
  })

  it("caps the page at 200 fields", () => {
    document.body.innerHTML = Array.from({ length: 250 }, (_value, index) => `<input aria-label="Question ${index}" name="q${index}" />`).join("")
    expect(page().read()).toHaveLength(200)
  })

  it("reads only the form that has a submit control, falling back to the document when none does", () => {
    document.body.innerHTML = `
      <form><label for="outside">Outside</label><input id="outside" /></form>
      <form><label for="inside">Inside</label><input id="inside" /><button type="submit">Submit</button></form>
    `
    expect(page().read().map((field) => field.label)).toEqual(["Inside"])
  })

  it("groups nameless radios by their fieldset, not by their index", () => {
    document.body.innerHTML = `
      <form>
        <fieldset>
          <legend>First group</legend>
          <label><input type="radio" name="" value="yes" />Yes</label>
          <label><input type="radio" name="" value="no" />No</label>
        </fieldset>
        <fieldset>
          <legend>Second group</legend>
          <label><input type="radio" name="" value="a" />A</label>
          <label><input type="radio" name="" value="b" />B</label>
        </fieldset>
      </form>
    `
    expect(page().read()).toEqual([
      { ref: "r0", label: "First group", kind: "radio", required: false, options: ["Yes", "No"] },
      { ref: "r1", label: "Second group", kind: "radio", required: false, options: ["A", "B"] },
    ])
  })

  it("reads a label with a nested select without its option text (parity with labelText)", () => {
    document.body.innerHTML = `
      <form>
        <label>Country of residence <input id="country" name="country" />
          <select name="noise"><option>Nigeria</option><option>Ghana</option></select>
        </label>
      </form>
    `
    const fields = page().read()
    expect(fields[0]).toMatchObject({ label: "Country of residence", kind: "text" })
    expect(fields[0]?.label).not.toContain("Nigeria")
  })

  it("does not reject a visually hidden (opacity 0) control that a visible label names", () => {
    document.body.innerHTML = '<form><label for="custom">Custom choice</label><input id="custom" type="checkbox" style="opacity: 0" /></form>'
    expect(page().read()).toEqual([{ ref: "f0", label: "Custom choice", kind: "checkbox", required: false }])
  })

  it("refuses a text control the Candidate cannot see: opacity 0.01, off-screen, 1x1 or clip-path", () => {
    document.body.innerHTML = `
      <form>
        <label for="seen">Seen</label><input id="seen" />
        <label for="faint">Gender</label><input id="faint" style="opacity: 0.01" />
        <label for="offscreen">Race</label><input id="offscreen" />
        <label for="tiny">Disability</label><input id="tiny" />
        <label for="clipped">Salary expectation</label><input id="clipped" style="clip-path: inset(50%)" />
      </form>
    `
    showLayout()
    place(document.getElementById("seen") as HTMLElement)
    place(document.getElementById("faint") as HTMLElement)
    place(document.getElementById("offscreen") as HTMLElement, rect(-500, 10, 200, 24))
    place(document.getElementById("tiny") as HTMLElement, rect(10, 10, 1, 1))
    place(document.getElementById("clipped") as HTMLElement)
    expect(page().read()).toEqual([{ ref: "f0", label: "Seen", kind: "text", required: false }])
  })

  it("refuses a control a hidden ancestor makes invisible", () => {
    document.body.innerHTML = `
      <form>
        <label for="seen">Seen</label><input id="seen" />
        <div style="opacity: 0.01"><label for="wrapped">Race</label><input id="wrapped" /></div>
      </form>
    `
    showLayout()
    place(document.getElementById("seen") as HTMLElement)
    place(document.getElementById("wrapped") as HTMLElement)
    expect(page().read()).toEqual([{ ref: "f0", label: "Seen", kind: "text", required: false }])
  })


  it("keeps a custom control whose native input is hidden but whose label is visible", () => {
    document.body.innerHTML = `
      <form>
        <label for="agree"><input id="agree" type="checkbox" style="opacity: 0; width: 1px; height: 1px" /> I agree</label>
        <label for="gender">Gender</label><input id="gender" style="opacity: 0; width: 1px; height: 1px" />
      </form>
    `
    showLayout()
    place(document.querySelector('label[for="agree"]') as HTMLElement)
    place(document.getElementById("agree") as HTMLElement, rect(10, 10, 1, 1))
    // The text input's label is visible too, but a text control gets no label exception.
    place(document.querySelector('label[for="gender"]') as HTMLElement)
    place(document.getElementById("gender") as HTMLElement, rect(10, 10, 1, 1))
    expect(page().read()).toEqual([{ ref: "f0", label: "I agree", kind: "checkbox", required: false }])
  })

  it("reads a custom uploader's 0x0 input when its field container is visible and has text", () => {
    document.body.innerHTML = `
      <form>
        <div class="field" id="resume-field">
          <h3>Resume</h3>
          <input type="file" id="_systemfield_resume" name="_systemfield_resume" style="width: 0; height: 0; opacity: 0" />
        </div>
      </form>
    `
    showLayout()
    const input = document.getElementById("_systemfield_resume") as HTMLInputElement
    Object.defineProperty(input, "getBoundingClientRect", { configurable: true, value: () => rect(0, 0, 0, 0) })
    Object.defineProperty(input, "checkVisibility", { configurable: true, value: () => false })
    place(document.getElementById("resume-field") as HTMLElement)
    expect(page().read()).toEqual([{ ref: "f0", label: "Resume", kind: "file", required: false }])
  })

  it("does not read a file input inside an off-screen, zero-size container with no visible text", () => {
    document.body.innerHTML = `
      <form>
        <div id="trap" style="width: 0; height: 0; overflow: hidden">
          <input type="file" id="_systemfield_resume" />
        </div>
        <label for="seen">Seen</label><input id="seen" />
      </form>
    `
    showLayout()
    Object.defineProperty(document.getElementById("_systemfield_resume") as HTMLElement, "checkVisibility", { configurable: true, value: () => false })
    expect(page().read().map((field) => field.label)).toEqual(["Seen"])
  })

  it("names a file input from its id or name tokens, and not from a look-alike token", () => {
    document.body.innerHTML = `
      <form>
        <input type="file" id="_systemfield_resume" name="_systemfield_resume" />
        <input type="file" id="cover_letter" name="cover_letter" />
        <input type="file" id="recvfile" name="recvfile" />
        <input type="file" id="discover_more" name="discover_more" />
      </form>
    `
    expect(page().read().map((field) => field.label)).toEqual(["Resume", "Cover letter", "File upload", "File upload"])
  })

  it("does not label a later file input Resume because a Resume field came before it", () => {
    document.body.innerHTML = `
      <form>
        <div class="field"><h3>Resume</h3><input type="file" id="_systemfield_resume" /></div>
        <div class="field"><h3>Other documents</h3><input type="file" id="other-upload" /></div>
      </form>
    `
    expect(page().read().map((field) => field.label)).toEqual(["Resume", "Other documents"])
  })

  it("skips the autofill uploader by its heading and by its id", () => {
    document.body.innerHTML = `
      <form>
        <div class="field"><h3>Autofill from resume</h3><input type="file" id="upload-document" /></div>
        <div class="field"><h3>Portfolio</h3><input type="file" id="_systemfield_autofill" /></div>
      </form>
    `
    expect(page().read().map((field) => field.label)).toEqual([])
  })

  it("reads a file input only when its accept lets a PDF through", () => {
    document.body.innerHTML = `
      <form>
        <input type="file" name="docx" accept=".docx" />
        <input type="file" name="images" accept="image/*" />
        <input type="file" name="pdf-ext" accept=".pdf" />
        <input type="file" name="pdf-type" accept="application/pdf" />
        <input type="file" name="any" accept="" />
        <input type="file" name="wild" accept="*/*" />
      </form>
    `
    expect(page().read().map((field) => field.label)).toEqual(["File upload", "File upload", "File upload", "File upload"])
  })

  it("fills a field below the fold, which a viewport test would wrongly hide", () => {
    document.body.innerHTML = '<form><label for="deep">Cover letter</label><input id="deep" /><button type="submit">Submit</button></form>'
    showLayout()
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 4000 })
    place(document.getElementById("deep") as HTMLElement, rect(10, 3000, 300, 24))
    expect(page().read().map((field) => field.label)).toEqual(["Cover letter"])
  })

  it("fills a field above the current scroll position", () => {
    document.body.innerHTML = '<form><label for="top">First name</label><input id="top" /><button type="submit">Submit</button></form>'
    showLayout()
    Object.defineProperty(window, "scrollY", { configurable: true, value: 5000 })
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 6000 })
    place(document.getElementById("top") as HTMLElement, rect(10, -4800, 300, 24))
    expect(page().read().map((field) => field.label)).toEqual(["First name"])
  })

  it("fills a field scrolled out of an inner container", () => {
    document.body.innerHTML = '<form><div id="scroller" style="overflow:auto;height:200px"><label for="deep">First name</label><input id="deep" /><button type="submit">Submit</button></div></form>'
    showLayout()
    const scroller = document.getElementById("scroller") as HTMLElement
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 2000 })
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 200 })
    scroller.scrollTop = 1500
    place(scroller, rect(0, 0, 400, 200))
    // 1400px above the viewport, but 100px inside the container's scrolled content.
    place(document.getElementById("deep") as HTMLElement, rect(10, -1400, 300, 24))
    expect(page().read().map((field) => field.label)).toEqual(["First name"])
  })

  it("does not treat a slanted polygon section as hidden", () => {
    document.body.innerHTML = '<form><div style="clip-path: polygon(0px 0px, 100% 0px, 100% 85%, 0px 100%)"><label for="slanted">First name</label><input id="slanted" /></div></form>'
    showLayout()
    place(document.getElementById("slanted") as HTMLElement)
    expect(page().read().map((field) => field.label)).toEqual(["First name"])
  })

  it("does not treat a rounded clip-path card as hidden", () => {
    document.body.innerHTML = '<form><div style="clip-path: inset(0 round 12px)"><label for="carded">First name</label><input id="carded" /></div></form>'
    showLayout()
    place(document.getElementById("carded") as HTMLElement)
    expect(page().read().map((field) => field.label)).toEqual(["First name"])
  })

  it("refuses a control inside a zero-size overflow-hidden wrapper", () => {
    document.body.innerHTML = '<form><div id="trap" style="width:0;height:0;overflow:hidden"><label for="trapfield">Gender</label><input id="trapfield" /></div><label for="seen">Seen</label><input id="seen" /></form>'
    showLayout()
    place(document.getElementById("trapfield") as HTMLElement)
    place(document.getElementById("seen") as HTMLElement)
    expect(page().read().map((field) => field.label)).toEqual(["Seen"])
  })

  it("still hides a collapsed polygon or a zero-radius circle", () => {
    document.body.innerHTML = `
      <form>
        <div style="clip-path: polygon(0 0, 0 0)"><label for="poly">Gender</label><input id="poly" /></div>
        <div style="clip-path: circle(0)"><label for="circle">Race</label><input id="circle" /></div>
        <label for="seen">Seen</label><input id="seen" />
      </form>
    `
    showLayout()
    place(document.getElementById("poly") as HTMLElement)
    place(document.getElementById("circle") as HTMLElement)
    place(document.getElementById("seen") as HTMLElement)
    expect(page().read().map((field) => field.label)).toEqual(["Seen"])
  })

  it("fills a field in a nested scroller inside an on-page app shell", () => {
    document.body.innerHTML = `
      <form>
        <div id="shell" style="overflow:auto;height:600px">
          <div id="inner" style="overflow:auto;height:300px">
            <label for="nested">First name</label><input id="nested" />
          </div>
        </div>
      </form>
    `
    showLayout()
    const shell = document.getElementById("shell") as HTMLElement
    Object.defineProperty(shell, "scrollHeight", { configurable: true, value: 5000 })
    Object.defineProperty(shell, "clientHeight", { configurable: true, value: 600 })
    shell.scrollTop = 1500
    place(shell, rect(0, 0, 400, 600))
    const inner = document.getElementById("inner") as HTMLElement
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 1000 })
    Object.defineProperty(inner, "clientHeight", { configurable: true, value: 300 })
    // Scrolled above the viewport, but inside the shell's scroll box.
    place(inner, rect(10, -500, 380, 300))
    place(document.getElementById("nested") as HTMLElement, rect(20, -490, 300, 24))
    expect(page().read().map((field) => field.label)).toEqual(["First name"])
  })

  it("refuses a field inside an off-page scrolling container", () => {
    document.body.innerHTML = '<form><div id="offpage" style="position:absolute;top:-9999px;overflow:auto;height:200px"><label for="hidden">Gender</label><input id="hidden" /></div><label for="seen">Seen</label><input id="seen" /></form>'
    showLayout()
    const offpage = document.getElementById("offpage") as HTMLElement
    Object.defineProperty(offpage, "scrollHeight", { configurable: true, value: 2000 })
    place(offpage, rect(0, -9999, 400, 200))
    place(document.getElementById("hidden") as HTMLElement, rect(10, -9900, 300, 24))
    place(document.getElementById("seen") as HTMLElement)
    expect(page().read().map((field) => field.label)).toEqual(["Seen"])
  })

  it("treats an almost transparent control as hidden", () => {
    document.body.innerHTML = '<form><label for="seen">Seen</label><input id="seen" /><label for="faint">Gender</label><input id="faint" style="opacity: 0.08" /></form>'
    showLayout()
    place(document.getElementById("seen") as HTMLElement)
    place(document.getElementById("faint") as HTMLElement)
    expect(page().read().map((field) => field.label)).toEqual(["Seen"])
  })

  it("flags a text input that offers choices as a combobox", () => {
    document.body.innerHTML = `
      <form>
        <input aria-label="Role" role="combobox" />
        <input aria-label="Technology" list="technologies" />
        <datalist id="technologies"><option>TypeScript</option></datalist>
        <input aria-label="Autocomplete" aria-autocomplete="list" />
        <input aria-label="Plain" />
      </form>
    `
    const byLabel = new Map(page().read().map((field) => [field.label, field]))
    expect(byLabel.get("Role")?.combobox).toBe(true)
    expect(byLabel.get("Technology")?.combobox).toBe(true)
    expect(byLabel.get("Autocomplete")?.combobox).toBe(true)
    expect(byLabel.get("Plain")?.combobox).toBeUndefined()
  })
})

describe("the page filler", () => {
  it("fills text, a select by option text and a radio by label, with input and change events", async () => {
    const events: string[] = []
    document.addEventListener("input", (event) => events.push(`${(event.target as HTMLInputElement).name}:input`))
    document.addEventListener("change", (event) => events.push(`${(event.target as HTMLInputElement).name}:change`))
    // The background reads the page first; its refs are what the fill call addresses.
    page().read()

    const result = await page().fill({
      values: [
        { ref: "f0", value: "Ada", kind: "text" },
        { ref: "f4", value: "Abuja", kind: "select" },
        { ref: "r5", value: "No", kind: "radio" },
      ],
      unanswered: [],
    })

    expect(result).toEqual({ filled: 3, attached: 0, unanswered: 1, mismatched: [] })
    expect((document.getElementById("first") as HTMLInputElement).value).toBe("Ada")
    expect((document.getElementById("office") as HTMLSelectElement).value).toBe("Abuja")
    expect((document.querySelector('input[value="no"]') as HTMLInputElement).checked).toBe(true)
    expect((document.querySelector('input[value="yes"]') as HTMLInputElement).checked).toBe(false)
    // City is required and still empty: it is outlined for the Candidate.
    const city = document.getElementById("city") as HTMLInputElement
    expect(city.style.outline).toBe("2px solid #b42318")
    expect(events).toEqual(expect.arrayContaining(["first_name:input", "first_name:change", "office:change", "veteran:change"]))
  })

  it("clears its outline once the Candidate fills the field", async () => {
    page().read()
    await page().fill({
      values: [
        { ref: "f0", value: "Ada", kind: "text" },
        { ref: "r5", value: "No", kind: "radio" },
      ],
      unanswered: [],
    })
    const city = document.getElementById("city") as HTMLInputElement
    expect(city.style.outline).toBe("2px solid #b42318")
    city.value = "Lagos"
    expect(await page().fill({ values: [], unanswered: [] })).toEqual({ filled: 0, attached: 0, unanswered: 0, mismatched: [] })
    expect(city.style.outline).toBe("")
  })

  it("reports a value the page refused as mismatched instead of claiming it was filled", async () => {
    page().read()
    const result = await page().fill({ values: [{ ref: "f8", value: "not a number", kind: "text" }], unanswered: [] })
    expect(result.filled).toBe(0)
    expect(result.mismatched).toEqual(["f8"])
  })

  it("outlines a required file input but never gives it a file", async () => {
    document.body.innerHTML = '<label for="cv">Resume</label><input id="cv" name="resume" type="file" required />'
    expect(page().read()).toEqual([{ ref: "f0", label: "Resume", kind: "file", required: true }])
    expect((await page().fill({ values: [], unanswered: [] })).unanswered).toBe(1)
    const input = document.getElementById("cv") as HTMLInputElement
    expect(input.style.outline).toBe("2px solid #b42318")
    expect(input.files?.length ?? 0).toBe(0)
    expect(await page().fill({ values: [{ ref: "f0", value: "cv.pdf", kind: "file" }], unanswered: [] })).toMatchObject({ filled: 0, mismatched: ["f0"] })
    expect(input.files?.length ?? 0).toBe(0)
  })

  it("attaches a prepared document through a DataTransfer, raises input and change, and verifies the name", async () => {
    document.body.innerHTML = '<form><div class="field"><h3>Resume</h3><input type="file" id="_systemfield_resume" style="width: 0; height: 0" /></div></form>'
    const input = document.getElementById("_systemfield_resume") as HTMLInputElement
    acceptFiles(input)
    vi.stubGlobal("DataTransfer", StubDataTransfer)
    const events: string[] = []
    document.addEventListener("input", (event) => events.push(event.type))
    document.addEventListener("change", (event) => events.push(event.type))

    expect(page().read().map((field) => field.label)).toEqual(["Resume"])
    const result = await page().fill({
      values: [],
      documents: [{ ref: "f0", name: "Ada Okafor - Resume.pdf", type: "application/pdf", base64: btoa("resume bytes") }],
      unanswered: [],
    })

    expect(result).toEqual({ filled: 0, attached: 1, unanswered: 0, mismatched: [] })
    expect(input.files?.[0]?.name).toBe("Ada Okafor - Resume.pdf")
    expect(input.files?.[0]?.type).toBe("application/pdf")
    expect(events).toEqual(["input", "change"])
  })

  /**
   * jsdom does not cascade a container's `display: none` into its child's
   * computed style; a real browser's `checkVisibility` does, so the fixture
   * stands in for the layout engine the extension actually runs on.
   */
  function hideBehind(container: HTMLElement, input: HTMLElement): void {
    container.style.display = "none"
    Object.defineProperty(input, "checkVisibility", { configurable: true, value: () => container.style.display !== "none" })
  }

  it("skips a document whose uploader was hidden after the read, and still attaches to the visible one", async () => {
    document.body.innerHTML = `
      <form>
        <div id="resume-field"><h3>Resume</h3><input type="file" id="resume" /></div>
        <div id="letter-field"><h3>Cover letter</h3><input type="file" id="letter" /></div>
      </form>
    `
    const resume = document.getElementById("resume") as HTMLInputElement
    const letter = document.getElementById("letter") as HTMLInputElement
    acceptFiles(resume)
    acceptFiles(letter)
    vi.stubGlobal("DataTransfer", StubDataTransfer)
    // The Candidate reviewed both uploaders; the page hides one before the fill.
    expect(page().read().map((field) => field.label)).toEqual(["Resume", "Cover letter"])
    hideBehind(document.getElementById("resume-field") as HTMLElement, resume)

    const result = await page().fill({
      values: [],
      documents: [
        { ref: "f0", name: "Ada Okafor - Resume.pdf", type: "application/pdf", base64: btoa("resume bytes") },
        { ref: "f1", name: "Ada Okafor - Cover Letter.pdf", type: "application/pdf", base64: btoa("letter bytes") },
      ],
      unanswered: [],
    })

    // The hidden uploader is reported exactly like a typed value that fails the same check.
    expect(result).toEqual({ filled: 0, attached: 1, unanswered: 0, mismatched: ["f0"] })
    expect(resume.files?.length ?? 0).toBe(0)
    expect(letter.files?.[0]?.name).toBe("Ada Okafor - Cover Letter.pdf")
  })

  it("reports a document the page renamed or a ref it never read as mismatched", async () => {
    document.body.innerHTML = '<form><input type="file" id="_systemfield_resume" /></form>'
    const input = document.getElementById("_systemfield_resume") as HTMLInputElement
    acceptFiles(input)
    // The assignment reaches the input but the page keeps a different file.
    vi.stubGlobal(
      "DataTransfer",
      class {
        readonly files = [new File(["x"], "renamed.pdf", { type: "application/pdf" })]
        readonly items = { add: () => undefined }
      }
    )
    page().read()
    const result = await page().fill({
      values: [],
      documents: [
        { ref: "f0", name: "Ada Okafor - Resume.pdf", type: "application/pdf", base64: btoa("resume bytes") },
        { ref: "f9", name: "Ada Okafor - Cover Letter.pdf", type: "application/pdf", base64: btoa("letter bytes") },
      ],
      unanswered: [],
    })
    expect(result).toEqual({ filled: 0, attached: 0, unanswered: 0, mismatched: ["f0", "f9"] })
  })

  it("refuses to attach a document to an input whose accept excludes a PDF", async () => {
    document.body.innerHTML = '<form><input type="file" id="attachment" accept=".pdf" /></form>'
    const input = document.getElementById("attachment") as HTMLInputElement
    acceptFiles(input)
    vi.stubGlobal("DataTransfer", StubDataTransfer)
    expect(page().read()).toEqual([{ ref: "f0", label: "File upload", kind: "file", required: false }])
    // The page may have changed its accept between the read and the fill.
    input.setAttribute("accept", ".docx")
    const result = await page().fill({
      values: [],
      documents: [{ ref: "f0", name: "Ada Okafor - Resume.pdf", type: "application/pdf", base64: btoa("resume bytes") }],
      unanswered: [],
    })
    expect(result).toEqual({ filled: 0, attached: 0, unanswered: 0, mismatched: ["f0"] })
    expect(input.files?.length ?? 0).toBe(0)
  })

  it("never clicks a file input or opens a file chooser", async () => {
    document.body.innerHTML = '<form><div class="field"><h3>Resume</h3><input type="file" id="_systemfield_resume" /></div></form>'
    const input = document.getElementById("_systemfield_resume") as HTMLInputElement
    acceptFiles(input)
    vi.stubGlobal("DataTransfer", StubDataTransfer)
    const click = vi.spyOn(HTMLInputElement.prototype, "click")
    page().read()
    await page().fill({
      values: [],
      documents: [{ ref: "f0", name: "Ada Okafor - Resume.pdf", type: "application/pdf", base64: btoa("resume bytes") }],
      unanswered: [],
    })
    expect(click).not.toHaveBeenCalled()
    click.mockRestore()
  })
  it("selects a select option by its value when no option text matches", async () => {
    document.body.innerHTML = '<form><label for="country">Country</label><select id="country"><option value="ng">Nigeria</option><option value="gh">Ghana</option></select></form>'
    page().read()
    const result = await page().fill({ values: [{ ref: "f0", value: "gh", kind: "select" }], unanswered: [] })
    expect(result).toEqual({ filled: 1, attached: 0, unanswered: 0, mismatched: [] })
    expect((document.getElementById("country") as HTMLSelectElement).value).toBe("gh")
  })

  it("clicks a controlled checkbox that only commits on a click, then verifies it after a frame", async () => {
    document.body.innerHTML = '<form><label for="agree">I agree</label><input id="agree" type="checkbox" required /></form>'
    const box = document.getElementById("agree") as HTMLInputElement
    let state = false
    // A controlled input ignores a property set and updates only from its click handler.
    Object.defineProperty(box, "checked", {
      configurable: true,
      get: () => state,
      set: () => undefined,
    })
    box.addEventListener("click", () => {
      state = !state
    })
    page().read()
    const result = await page().fill({ values: [{ ref: "f0", value: "yes", kind: "checkbox" }], unanswered: [] })
    expect(result).toEqual({ filled: 1, attached: 0, unanswered: 0, mismatched: [] })
    expect(state).toBe(true)
    expect(box.checked).toBe(true)
  })

  it("does not click a checkbox that already has the wanted state", async () => {
    document.body.innerHTML = '<form><label for="agree">I agree</label><input id="agree" type="checkbox" checked /></form>'
    const box = document.getElementById("agree") as HTMLInputElement
    let clicks = 0
    box.addEventListener("click", () => {
      clicks += 1
    })
    page().read()
    const result = await page().fill({ values: [{ ref: "f0", value: "true", kind: "checkbox" }], unanswered: [] })
    expect(result).toEqual({ filled: 1, attached: 0, unanswered: 0, mismatched: [] })
    expect(clicks).toBe(0)
    expect(box.checked).toBe(true)
  })

  it("reports a checkbox answer that is not a boolean as mismatched instead of unchecking it", async () => {
    document.body.innerHTML = '<form><label for="agree">I agree</label><input id="agree" type="checkbox" /></form>'
    page().read()
    const result = await page().fill({ values: [{ ref: "f0", value: "maybe", kind: "checkbox" }], unanswered: [] })
    expect(result).toEqual({ filled: 0, attached: 0, unanswered: 0, mismatched: ["f0"] })
    expect((document.getElementById("agree") as HTMLInputElement).checked).toBe(false)
  })

  it("reports a malformed ref as mismatched without touching the page", async () => {
    page().read()
    const result = await page().fill({ values: [{ ref: "x1", value: "Ada", kind: "text" }], unanswered: [] })
    expect(result).toMatchObject({ filled: 0, mismatched: ["x1"] })
  })

  it("clears old refs on a re-read and never fills a control that became hidden", async () => {
    document.body.innerHTML = '<form><label for="a">A</label><input id="a" /><label for="b">B</label><input id="b" /></form>'
    expect(page().read().map((field) => field.label)).toEqual(["A", "B"])
    const hidden = document.getElementById("a") as HTMLInputElement
    hidden.style.display = "none"
    expect(page().read().map((field) => field.label)).toEqual(["B"])
    // The hidden control kept no ref, so f0 now names B and B is the only control filled.
    expect(hidden.getAttribute("data-eve-ref")).toBeNull()
    const result = await page().fill({ values: [{ ref: "f0", value: "bee", kind: "text" }], unanswered: [] })
    expect(result).toEqual({ filled: 1, attached: 0, unanswered: 0, mismatched: [] })
    expect(hidden.value).toBe("")
    expect((document.getElementById("b") as HTMLInputElement).value).toBe("bee")
  })

  it("never fills a page-injected decoy that forges a data-eve-ref attribute", async () => {
    document.body.innerHTML = '<form><label for="a">A</label><input id="a" /></form>'
    page().read()
    const decoy = document.createElement("input")
    decoy.setAttribute("data-eve-ref", "f0")
    decoy.setAttribute("aria-label", "Decoy")
    document.querySelector("form")?.append(decoy)
    const result = await page().fill({ values: [{ ref: "f0", value: "Ada", kind: "text" }], unanswered: [] })
    expect(result).toEqual({ filled: 1, attached: 0, unanswered: 0, mismatched: [] })
    expect((document.getElementById("a") as HTMLInputElement).value).toBe("Ada")
    expect(decoy.value).toBe("")
  })

  it("replaces the ref map on a second read, so an old control never keeps its ref", async () => {
    document.body.innerHTML = '<form><label for="a">A</label><input id="a" /><label for="b">B</label><input id="b" /></form>'
    expect(page().read().map((field) => field.label)).toEqual(["A", "B"])
    ;(document.getElementById("a") as HTMLInputElement).style.display = "none"
    // The re-read gives f0 to B; A stays in the DOM but is no longer in the map.
    expect(page().read().map((field) => field.label)).toEqual(["B"])
    const result = await page().fill({ values: [{ ref: "f0", value: "bee", kind: "text" }], unanswered: [] })
    expect(result).toEqual({ filled: 1, attached: 0, unanswered: 0, mismatched: [] })
    expect((document.getElementById("a") as HTMLInputElement).value).toBe("")
    expect((document.getElementById("b") as HTMLInputElement).value).toBe("bee")
  })

  it("reports a ref that resolves to a hidden or duplicated control as mismatched", async () => {
    document.body.innerHTML = '<form><label for="a">A</label><input id="a" /><label for="b">B</label><input id="b" /></form>'
    page().read()
    const hidden = document.getElementById("a") as HTMLInputElement
    hidden.style.display = "none"
    expect(await page().fill({ values: [{ ref: "f0", value: "Ada", kind: "text" }], unanswered: [] })).toMatchObject({ mismatched: ["f0"] })

    // Two controls claiming one scalar ref is ambiguous, never a document-order guess.
    document.body.innerHTML = '<form><input id="one" /><input id="two" /></form>'
    document.getElementById("one")?.setAttribute("data-eve-ref", "f0")
    document.getElementById("two")?.setAttribute("data-eve-ref", "f0")
    expect(await page().fill({ values: [{ ref: "f0", value: "Ada", kind: "text" }], unanswered: [] })).toMatchObject({ mismatched: ["f0"] })
  })
})

describe("the stepped page API (the background fills one item at a time)", () => {
  const VALUES: EvePageValue[] = [
    { ref: "f0", value: "Ada", kind: "text" },
    { ref: "f4", value: "Abuja", kind: "select" },
    { ref: "r5", value: "No", kind: "radio" },
  ]

  /** What the Candidate would see on the page, independent of how it got there. */
  function painted(): Record<string, unknown> {
    return {
      first: (document.getElementById("first") as HTMLInputElement | null)?.value,
      office: (document.getElementById("office") as HTMLSelectElement | null)?.value,
      veteran: [...document.querySelectorAll<HTMLInputElement>('input[name="veteran"]')].map((input) => input.checked),
      cityOutline: (document.getElementById("city") as HTMLInputElement | null)?.style.outline,
      firstOutline: (document.getElementById("first") as HTMLInputElement | null)?.style.outline,
    }
  }

  it("P1: begin, fillValue and finish paint exactly what fill paints", async () => {
    page().read()
    await page().fill({ values: VALUES, unanswered: [] })
    const oneCall = painted()

    document.body.innerHTML = FORM
    page().read()
    page().begin()
    for (const value of VALUES) expect(await page().fillValue(value)).toBe(true)
    expect(page().finish()).toEqual({ unanswered: 1 })
    expect(painted()).toEqual(oneCall)
  })

  it("P1: attachFile attaches exactly what fill attaches", async () => {
    const fixture = '<form><div class="field"><h3>Resume</h3><input type="file" id="cv" /></div></form>'
    const documentPayload: EvePageDocument = { ref: "f0", name: "Ada Okafor - Resume.pdf", type: "application/pdf", base64: btoa("resume bytes") }
    vi.stubGlobal("DataTransfer", StubDataTransfer)

    document.body.innerHTML = fixture
    const oneCallInput = document.getElementById("cv") as HTMLInputElement
    acceptFiles(oneCallInput)
    page().read()
    await page().fill({ values: [], documents: [documentPayload], unanswered: [] })
    const oneCall = oneCallInput.files?.[0]?.name

    document.body.innerHTML = fixture
    const steppedInput = document.getElementById("cv") as HTMLInputElement
    acceptFiles(steppedInput)
    page().read()
    page().begin()
    expect(await page().attachFile(documentPayload)).toBe(true)
    expect(page().finish()).toEqual({ unanswered: 0 })
    expect(steppedInput.files?.[0]?.name).toBe(oneCall)
    expect(oneCall).toBe("Ada Okafor - Resume.pdf")
  })

  it("P2: no step focuses, scrolls or blurs anything", async () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    const blur = vi.spyOn(HTMLElement.prototype, "blur")
    const scroll = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll })
    vi.stubGlobal("DataTransfer", StubDataTransfer)

    page().read()
    page().begin()
    for (const value of VALUES) await page().fillValue(value)
    page().finish()
    await page().fill({ values: VALUES, unanswered: [] })

    expect(focus).not.toHaveBeenCalled()
    expect(blur).not.toHaveBeenCalled()
    expect(scroll).not.toHaveBeenCalled()
    focus.mockRestore()
    blur.mockRestore()
  })

  it("P3: fillValue with a ref the page does not have returns false and touches nothing", async () => {
    const events: string[] = []
    document.addEventListener("input", (event) => events.push(event.type))
    document.addEventListener("change", (event) => events.push(event.type))
    page().read()

    expect(await page().fillValue({ ref: "f43", value: "Ada", kind: "text" })).toBe(false)
    expect(await page().fillValue({ ref: "not-a-ref", value: "Ada", kind: "text" })).toBe(false)
    expect((document.getElementById("first") as HTMLInputElement).value).toBe("")
    expect(events).toEqual([])
    expect((document.getElementById("first") as HTMLInputElement).style.outline).toBe("")
  })

  it("P4: finish outlines only the required fields still empty", async () => {
    page().read()
    page().begin()
    expect(await page().fillValue({ ref: "f0", value: "Ada", kind: "text" })).toBe(true)

    // The required radio group and the required city are still empty; the filled name is not outlined.
    expect(page().finish()).toEqual({ unanswered: 2 })
    expect((document.getElementById("first") as HTMLInputElement).style.outline).toBe("")
    expect((document.getElementById("city") as HTMLInputElement).style.outline).toBe("2px solid #b42318")
    expect((document.querySelector('input[value="yes"]') as HTMLInputElement).style.outline).toBe("2px solid #b42318")
  })
})
