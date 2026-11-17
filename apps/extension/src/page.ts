/**
 * Injected into the employer's tab (ADR 0016): READ the form, FILL it, attach
 * the prepared documents the review approved, and never submit or open a link,
 * never open a file chooser. It may click a checkbox or radio to set it the way
 * the Candidate would.
 *
 * This is a classic script with no imports: Chrome injects `files` as classic
 * scripts, and the wrapped body keeps its names out of the page's global scope.
 * It installs `globalThis.__evePage`, which the background worker calls with
 * `chrome.scripting.executeScript({ func })` in the same isolated world. The
 * label precedence is the automatic reader's (aria-label, aria-labelledby,
 * label[for], the wrapping label, the fieldset legend, placeholder, name), and
 * it uses the automatic reader's `labelText` copy, so a label Eve classifies
 * means what it means there.
 */
void (() => {
  /** Controls whose value Eve never reads or sets. `password` is a sign-in form, not an application field. */
  const SKIP_TYPES: ReadonlySet<string> = new Set(["hidden", "submit", "button", "image", "reset", "password"])
  const MAX_FIELDS = 200
  const MAX_LABEL = 300
  const MAX_OPTIONS = 100
  const MAX_OPTION_TEXT = 200
  const REF_PATTERN = /^[fr]\d{1,4}$/
  const OUTLINE = "2px solid #b42318"
  const OUTLINE_MARK = "data-eve-outline"
  /** Below this opacity a control is treated as hidden, not as "washed out but visible". */
  const MIN_OPACITY = 0.1
  /** A control the Candidate could not see or hit on screen. */
  const MIN_RECT = 4
  /** Ashby's system fields name their documents by id or name: `_systemfield_resume`, `cover_letter`. */
  const RESUME_TOKEN = /(^|[^a-z])(resume|cv|curriculum)([^a-z]|$)/i
  const COVER_LETTER_TOKEN = /(^|[^a-z])cover[^a-z]?letter/i

  /**
   * The ref -> element list of the last read. A page can forge any DOM
   * attribute (`data-eve-ref`), so refs live only in this closure: read()
   * replaces the map and fill() reads it. A re-read therefore drops every old
   * ref, and a page-injected decoy cannot receive a value.
   */
  const refs = new Map<string, HTMLElement[]>()

  /**
   * The question text of a label, legend or labelling element without the text
   * of controls nested in it (Lever puts the select inside its label, so
   * innerText would end in "Please select Yes No"). This is the automatic
   * reader's `labelText` (`apps/api/src/submission/browser/form-scripts.ts`),
   * inlined because this file is a classic script.
   */
  function labelText(el: Element | null): string {
    if (!el) return ""
    const skip = /^(select|option|optgroup|datalist|input|textarea|button|script|style|template|noscript)$/i
    const parts: string[] = []
    const walk = (node: Node): void => {
      if (node.nodeType === 3) {
        parts.push(node.nodeValue ?? "")
        return
      }
      if (node.nodeType !== 1) return
      const element = node as Element
      // A skipped node still separates the words around it.
      parts.push(" ")
      if (skip.test(element.tagName || "")) return
      const role = element.getAttribute("role") ?? ""
      if (/^(listbox|option|combobox|button|textbox|radio|checkbox)$/i.test(role)) return
      if (element.getAttribute("hidden") !== null || element.getAttribute("aria-hidden") === "true") return
      if (typeof (element as HTMLElement).checkVisibility === "function" && !(element as HTMLElement).checkVisibility()) return
      for (const child of Array.from(element.childNodes)) walk(child)
      parts.push(" ")
    }
    walk(el)
    return parts.join("").replace(/\s+/g, " ").trim()
  }

  /** A label from an attribute or a labelling element: aria-label, aria-labelledby, label[for], a wrapping label. */
  function namedLabel(element: HTMLElement): string {
    const aria = element.getAttribute("aria-label")
    if (aria !== null && aria.trim() !== "") return aria.replace(/\s+/g, " ").trim()
    const labelledBy = element.getAttribute("aria-labelledby")
    if (labelledBy !== null && labelledBy.trim() !== "") {
      return labelledBy
        .split(/\s+/)
        .map((id) => labelText(document.getElementById(id)))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    }
    if (element.id !== "") {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
      if (label !== null) return labelText(label)
    }
    const wrapping = element.closest("label")
    if (wrapping !== null) return labelText(wrapping)
    return ""
  }

  function labelOf(element: HTMLElement): string {
    const named = namedLabel(element)
    if (named !== "") return named
    const set = element.closest("fieldset")
    if (set !== null) return labelText(set.querySelector("legend"))
    return (element.getAttribute("placeholder") ?? element.getAttribute("name") ?? "").replace(/\s+/g, " ").trim()
  }

  /**
   * The field wrapper a custom uploader draws around its hidden native input:
   * the nearest ancestor, at most three levels up, that holds exactly one file
   * input. Text outside it belongs to another field, never to this one.
   */
  function fieldContainer(element: HTMLInputElement): HTMLElement | null {
    let node = element.parentElement
    for (let depth = 0; node !== null && depth < 3; depth++, node = node.parentElement) {
      if (node.querySelectorAll('input[type="file"]').length === 1) return node
    }
    return null
  }

  /** The text before a control inside its own field container; never a sibling field's text. */
  function textBefore(element: HTMLElement, container: HTMLElement): string {
    let node: HTMLElement | null = element
    while (node !== null && node !== container) {
      for (let sibling = node.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling) {
        const text = labelText(sibling)
        if (text !== "") return text
      }
      node = node.parentElement
    }
    return ""
  }

  /**
   * The prompt of a file input: a real label first, then the text above it in
   * its own field container, then the id or name Ashby gives its system fields,
   * then the generic fallback. A look-alike token (`recvfile`, `discover_more`)
   * never names a document.
   */
  function fileLabel(element: HTMLInputElement): string {
    const named = namedLabel(element)
    if (named !== "") return named
    const container = fieldContainer(element)
    if (container !== null) {
      const near = textBefore(element, container)
      if (near !== "") return near
    }
    const tokens = `${element.id} ${element.name}`
    if (RESUME_TOKEN.test(tokens)) return "Resume"
    if (COVER_LETTER_TOKEN.test(tokens)) return "Cover letter"
    return "File upload"
  }

  /** Ashby's "Autofill from resume" uploader is not an application document. */
  function isAutofillUploader(element: HTMLInputElement): boolean {
    const container = fieldContainer(element)
    const containerText = container === null ? "" : labelText(container)
    return /autofill/i.test(`${fileLabel(element)} ${element.id} ${element.name} ${containerText}`)
  }

  /**
   * A file input is read even when its native box is tiny or zero: a custom
   * uploader hides the native input and draws a sibling drop zone. It is visible
   * when the input itself is, or when its field container is visible and carries
   * text the Candidate can read. A disconnected or explicitly hidden control is
   * not, and neither is one whose whole container is off the page.
   */
  function fileVisible(element: HTMLInputElement): boolean {
    if (!element.isConnected) return false
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false
    const style = getComputedStyle(element)
    if (style.display === "none" || style.visibility === "hidden") return false
    if (selfVisible(element)) return true
    const container = fieldContainer(element)
    return container !== null && selfVisible(container) && labelText(container) !== ""
  }

  /** A PDF may go into a file input unless its `accept` names other types only. */
  function acceptsPdf(element: HTMLInputElement): boolean {
    const accept = (element.getAttribute("accept") ?? "").trim()
    if (accept === "") return true
    return accept.split(",").some((token) => {
      const value = token.trim().toLowerCase()
      return value === "*/*" || value === "application/*" || value === "application/pdf" || value === ".pdf"
    })
  }

  /** The label an option of a radio stands for: its own label, else its value. */
  function optionLabel(input: HTMLInputElement): string {
    if (input.id !== "") {
      const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
      if (label !== null && labelText(label) !== "") return labelText(label)
    }
    const wrapping = input.closest("label")
    if (wrapping !== null && labelText(wrapping) !== "") return labelText(wrapping)
    return input.value
  }

  /**
   * A box the Candidate can reach: at least 4x4 and inside the document's scrollable box, in document
   * coordinates. The rect is viewport-relative, so scrollX/scrollY are added: a field above the current scroll
   * position is still a field. Only a box pushed outside the page (left: -9999px, top: -9999px) is a trap.
   */
  function inDocument(element: HTMLElement): boolean {
    const rect = element.getBoundingClientRect()
    if (rect.width < MIN_RECT || rect.height < MIN_RECT) return false
    const doc = element.ownerDocument.documentElement
    const view = element.ownerDocument.defaultView
    const left = rect.left + (view?.scrollX ?? 0)
    const top = rect.top + (view?.scrollY ?? 0)
    const width = Math.max(doc.scrollWidth, doc.clientWidth, view?.innerWidth ?? 0)
    const height = Math.max(doc.scrollHeight, doc.clientHeight, view?.innerHeight ?? 0)
    return left + rect.width > 0 && top + rect.height > 0 && left < width && top < height
  }

  /**
   * Only a clip that removes the whole box hides a control. `inset(0 round 12px)` on a card, or a slanted
   * `polygon(0 0, 100% 0, 100% 85%)` section, is styling; only a collapsed box is a trap.
   */
  function hidesByClip(clipPath: string): boolean {
    return /inset\(\s*(50|100)%|circle\(\s*0(px|%)?\s*(at|\))|polygon\(\s*(?:0(?:px|%)?\s+0(?:px|%)?\s*,?\s*)+\)/.test(clipPath)
  }

  /** An ancestor that scrolls or clips its content: the control must be inside that ancestor's scroll box. */
  function clipsOrScrolls(style: CSSStyleDeclaration): boolean {
    return /(auto|scroll|hidden|clip)/.test(style.overflow)
  }

  /** The root boxes pass their overflow to the viewport; a scroll lock on them must not hide every field. */
  function isRootBox(node: HTMLElement): boolean {
    const doc = node.ownerDocument
    return node === doc.documentElement || node === doc.body
  }

  /**
   * Visible to the Candidate on its own merits. A hidden native input is
   * deliberately not enough to reject a custom radio or checkbox: it draws its
   * own mark and `controlVisible` allows it through its visible label. jsdom has
   * no layout engine, so a document that reports no layout at all is read by its
   * styles: that keeps the unit test honest without letting a hidden control
   * through in a real browser.
   */
  function selfVisible(element: HTMLElement): boolean {
    if (!element.isConnected) return false
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false
    const style = getComputedStyle(element)
    if (style.display === "none" || style.visibility === "hidden") return false
    // Opacity multiplies down the tree, and an ancestor can clip or scroll the control away, so walk up.
    let opacity = 1
    let outerScroller: HTMLElement | null = null
    const ownRect = element.getBoundingClientRect()
    for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
      const ancestor = getComputedStyle(node)
      const own = Number.parseFloat(ancestor.opacity)
      if (Number.isFinite(own)) opacity *= own
      if (ancestor.clipPath !== "" && ancestor.clipPath !== "none" && hidesByClip(ancestor.clipPath)) return false
      if (ancestor.clip !== "" && ancestor.clip !== "auto") return false
      if (node !== element && clipsOrScrolls(ancestor) && !isRootBox(node)) {
        // A control is reachable when it sits inside this ancestor's scroll box. That keeps a field scrolled out of
        // an inner container (an SPA shell, a modal, a Workday step) fillable, while a zero-size or out-of-box
        // wrapper still hides its contents, which is the trap this check exists for.
        const box = node.getBoundingClientRect()
        const x = ownRect.left - box.left + node.scrollLeft
        const y = ownRect.top - box.top + node.scrollTop
        const width = Math.max(node.scrollWidth, node.clientWidth, box.width)
        const height = Math.max(node.scrollHeight, node.clientHeight, box.height)
        if (x + ownRect.width <= 0 || x >= width || y + ownRect.height <= 0 || y >= height) return false
        // Keep the outermost scrolling box: an inner box can sit above the viewport inside an on-page shell, and
        // the loop already checked the field against each inner box's scroll box.
        if (/auto|scroll/.test(ancestor.overflow)) outerScroller = node
      }
    }
    if (opacity < MIN_OPACITY) return false
    // jsdom has no layout and no checkVisibility: styles alone decide there. A real browser (Chrome 105+) always
    // has it, so geometry is never skipped in the browser the extension runs in.
    if (typeof element.checkVisibility !== "function") return true
    if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false
    // The outermost scrolling box stands in for the window: a field inside it is reachable, but the box itself
    // still has to be on the page, so an off-page scrolling container is refused rather than becoming a hiding place.
    return inDocument(outerScroller ?? element)
  }

  /** The element that names a control, when a label element does (aria-label names none). */
  function namingLabel(element: HTMLElement): HTMLElement | null {
    const labelledBy = element.getAttribute("aria-labelledby")
    if (labelledBy !== null && labelledBy.trim() !== "") {
      const named = document.getElementById(labelledBy.split(/\s+/)[0] ?? "")
      if (named instanceof HTMLElement) return named
    }
    if (element.id !== "") {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
      if (label instanceof HTMLElement) return label
    }
    const wrapping = element.closest("label")
    return wrapping instanceof HTMLElement ? wrapping : null
  }

  /**
   * A control is fillable only when it is genuinely visible, or when it is a
   * radio/checkbox whose naming label is visible (a custom control). A hidden
   * text input with a visible label stays unfillable: that is the harvest the
   * review step exists to stop, and it starts with the reader.
   */
  function controlVisible(element: HTMLElement, kind: EveFieldKind): boolean {
    // A file input's native box is hidden by design on custom uploaders, so it is judged without geometry.
    if (kind === "file") return element instanceof HTMLInputElement && fileVisible(element)
    if (selfVisible(element)) return true
    if (kind !== "radio" && kind !== "checkbox") return false
    const label = namingLabel(element)
    return label !== null && selfVisible(label)
  }

  function kindOf(element: HTMLElement): EveFieldKind | "skip" {
    if (element instanceof HTMLSelectElement) return "select"
    if (element instanceof HTMLTextAreaElement) return "textarea"
    if (!(element instanceof HTMLInputElement)) return "skip"
    const type = (element.getAttribute("type") ?? "text").toLowerCase()
    if (SKIP_TYPES.has(type)) return "skip"
    if (type === "checkbox") return "checkbox"
    if (type === "file") return "file"
    if (type === "radio") return "radio"
    return "text"
  }

  /** A text input that offers choices: role=combobox, aria-autocomplete or a datalist. */
  function isCombobox(element: HTMLElement): boolean {
    return (
      (element.getAttribute("role") ?? "").trim().toLowerCase() === "combobox" ||
      element.hasAttribute("list") ||
      !/^(none|)$/i.test((element.getAttribute("aria-autocomplete") ?? "").trim())
    )
  }

  function isRequired(element: HTMLElement): boolean {
    return (
      (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) &&
      (element.required || element.getAttribute("aria-required") === "true")
    )
  }

  /** The visible submit controls of a form: what makes it the application form, not a search box. */
  function submitsOf(form: Element): Element[] {
    return [...form.querySelectorAll("button, input[type=submit], input[type=image]")]
      .filter((element) => element.tagName !== "BUTTON" || (element.getAttribute("type") ?? "submit").toLowerCase() === "submit")
      .filter((element) => element instanceof HTMLElement && selfVisible(element) && !(element as HTMLButtonElement | HTMLInputElement).disabled)
  }

  /** Read the form that has a submit control; when no form does, read the document (a single-page form). */
  function formScope(): ParentNode {
    const forms = [...document.querySelectorAll("form")].filter((form) => submitsOf(form).length > 0)
    return forms[0] ?? document
  }

  /** The legend, aria-label or fallback label of a radio group's container. */
  function radioGroupLabel(input: HTMLInputElement, container: Element | null): string {
    if (container !== null) {
      if ((container.getAttribute("role") ?? "").trim().toLowerCase() === "radiogroup") {
        const aria = container.getAttribute("aria-label")
        if (aria !== null && aria.trim() !== "") return aria.replace(/\s+/g, " ").trim()
        const labelledBy = container.getAttribute("aria-labelledby")
        if (labelledBy !== null && labelledBy.trim() !== "") {
          return labelledBy
            .split(/\s+/)
            .map((id) => labelText(document.getElementById(id)))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
        }
      }
      const legend = labelText(container.querySelector("legend"))
      if (legend !== "") return legend
    }
    return labelOf(input)
  }

  /** Records one control under a ref; a radio group's ref holds every option. */
  function addRef(ref: string, element: HTMLElement): void {
    const nodes = refs.get(ref)
    if (nodes === undefined) refs.set(ref, [element])
    else nodes.push(element)
  }

  function refFor(element: HTMLElement): string | null {
    for (const [ref, nodes] of refs) if (nodes.includes(element)) return ref
    return null
  }

  function read(): EvePageField[] {
    // Refs are per-read handles. A re-read replaces the whole map, so a
    // re-render can never leave an old, hidden control holding f3 while a new
    // control is also given f3.
    refs.clear()
    const fields: EvePageField[] = []
    const byContainer = new WeakMap<Element, EvePageField>()
    const byName = new Map<string, EvePageField>()
    let index = 0
    for (const element of formScope().querySelectorAll<HTMLElement>("input, textarea, select")) {
      if (fields.length >= MAX_FIELDS) break
      const kind = kindOf(element)
      if (kind === "skip" || !controlVisible(element, kind)) continue
      if (kind === "file" && element instanceof HTMLInputElement) {
        // A PDF never goes into an uploader that accepts only DOCX or images...
        if (!acceptsPdf(element)) continue
        // ...and Ashby's third uploader feeds "Autofill from resume", not the resume.
        if (isAutofillUploader(element)) continue
      }
      if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.readOnly) continue
      if (element instanceof HTMLInputElement && element.disabled) continue
      if ((element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && element.disabled) continue

      if (kind === "radio" && element instanceof HTMLInputElement) {
        // Nameless radios have no name to group by; their fieldset or radiogroup
        // is the group. A named group outside one still groups by name.
        const container = element.closest("fieldset, [role='radiogroup']")
        let group = container === null ? undefined : byContainer.get(container)
        if (group === undefined && container === null && element.name !== "") group = byName.get(element.name)
        if (group === undefined) {
          const ref = `r${index++}`
          group = {
            ref,
            label: radioGroupLabel(element, container).slice(0, MAX_LABEL),
            kind: "radio",
            required: isRequired(element),
            options: [],
          }
          if (container !== null) byContainer.set(container, group)
          else if (element.name !== "") byName.set(element.name, group)
          fields.push(group)
        }
        addRef(group.ref, element)
        group.required = group.required || isRequired(element)
        const option = optionLabel(element).slice(0, MAX_OPTION_TEXT)
        const options = group.options ?? []
        if (option !== "" && !options.includes(option) && options.length < MAX_OPTIONS) options.push(option)
        group.options = options
        continue
      }

      const ref = `f${index++}`
      addRef(ref, element)
      const label = kind === "file" && element instanceof HTMLInputElement ? fileLabel(element) : labelOf(element)
      const field: EvePageField = { ref, label: label.slice(0, MAX_LABEL), kind, required: isRequired(element) }
      if (kind === "text" && isCombobox(element)) field.combobox = true
      if (kind === "select" && element instanceof HTMLSelectElement) {
        field.options = [...element.options]
          .map((option) => option.text.replace(/\s+/g, " ").trim().slice(0, MAX_OPTION_TEXT))
          .filter((text) => text !== "")
          .slice(0, MAX_OPTIONS)
      }
      fields.push(field)
    }
    return fields
  }

  /** Sets a property through its prototype setter, as a typing Candidate's own input would. */
  function setNative(element: HTMLElement, property: "value" | "checked", value: string | boolean): boolean {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property)
    if (descriptor?.set === undefined) return false
    descriptor.set.call(element, value)
    return true
  }

  function dispatch(element: HTMLElement): void {
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  }

  /** A checkbox answer is a boolean, never page text. Anything else is not a value Eve may set. */
  function checkboxValue(value: string): boolean | null {
    const text = value.trim().toLowerCase()
    if (text === "yes" || text === "true" || text === "1" || text === "on") return true
    if (text === "no" || text === "false" || text === "0" || text === "off") return false
    return null
  }

  /** React and other controlled inputs commit on the event's click, not on a property set. Wait a task before reading back. */
  function nextFrame(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
  }

  /** One planned value: type it in, choose it, or check it; then verify after the page had a turn. */
  async function setValue(nodes: readonly HTMLElement[], value: EvePageValue): Promise<boolean> {
    if (value.kind === "file") return false
    if (value.kind === "radio") {
      // A radio group's ref deliberately tags every option; any other duplicate is ambiguous.
      const radios = nodes.filter((node): node is HTMLInputElement => node instanceof HTMLInputElement)
      if (radios.length === 0 || radios.length !== nodes.length) return false
      if (!radios.some((node) => controlVisible(node, "radio"))) return false
      const target = radios.find((node) => optionLabel(node) === value.value || node.value === value.value)
      if (target === undefined || !controlVisible(target, "radio")) return false
      // A controlled radio only changes on a real click, and the click is the Candidate's own selection.
      if (!target.checked) target.click()
      await nextFrame()
      return target.checked
    }
    // A scalar ref must name exactly one live control: a stale or duplicated ref is a mismatch, never a guess.
    if (nodes.length !== 1) return false
    const first = nodes[0]!
    if (!controlVisible(first, value.kind)) return false
    if (value.kind === "checkbox") {
      if (!(first instanceof HTMLInputElement)) return false
      const wanted = checkboxValue(value.value)
      if (wanted === null) return false
      if (first.checked !== wanted) first.click()
      await nextFrame()
      return first.checked === wanted
    }
    if (value.kind === "select") {
      if (!(first instanceof HTMLSelectElement)) return false
      const options = [...first.options]
      const option = options.find((item) => item.text.replace(/\s+/g, " ").trim() === value.value) ?? options.find((item) => item.value === value.value)
      if (option === undefined) return false
      if (!setNative(first, "value", option.value)) return false
      dispatch(first)
      await nextFrame()
      return first.value === option.value
    }
    if (first instanceof HTMLInputElement || first instanceof HTMLTextAreaElement) {
      if (!setNative(first, "value", value.value)) return false
      dispatch(first)
      await nextFrame()
      return first.value === value.value
    }
    return false
  }

  function clearOutlines(): void {
    for (const element of document.querySelectorAll<HTMLElement>(`[${OUTLINE_MARK}]`)) {
      element.style.outline = ""
      element.style.outlineOffset = ""
      element.removeAttribute(OUTLINE_MARK)
    }
  }

  /**
   * Outlines every required control left without a value, and counts them once
   * per field. A required file input is outlined until a file is attached, then
   * cleared like any other answered field.
   */
  function outlineRequired(): number {
    const seen = new Set<string>()
    let unanswered = 0
    for (const element of document.querySelectorAll<HTMLElement>("input, textarea, select")) {
      if (!isRequired(element)) continue
      const kind = kindOf(element)
      if (kind === "skip" || !controlVisible(element, kind)) continue
      const ref = refFor(element)
      if (ref !== null && seen.has(ref)) continue
      const members = ref === null ? [element] : refs.get(ref) ?? [element]
      const filled =
        element instanceof HTMLInputElement && element.type === "radio"
          ? members.some((node) => node instanceof HTMLInputElement && node.checked)
          : element instanceof HTMLInputElement && element.type === "checkbox"
            ? element.checked
            : element instanceof HTMLInputElement && element.type === "file"
              ? (element.files?.length ?? 0) > 0
              : (element as HTMLInputElement).value.trim() !== ""
      if (filled) continue
      if (ref !== null) seen.add(ref)
      unanswered++
      // A custom radio/checkbox draws itself, so its visible label gets the outline.
      const outlined = selfVisible(element) ? element : namingLabel(element) ?? element
      outlined.style.outline = OUTLINE
      outlined.style.outlineOffset = "1px"
      outlined.setAttribute(OUTLINE_MARK, "")
    }
    return unanswered
  }

  /** The prepared PDF the bridge downloaded, as the browser File the file input expects. */
  function documentFile(document: EvePageDocument): File {
    const binary = atob(document.base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return new File([bytes], document.name, { type: document.type })
  }

  /**
   * Attaches one prepared document to the file input its ref names. A file
   * input cannot take a value the way a text input does: the browser only
   * honours a `FileList` from a `DataTransfer`, followed by `input` and
   * `change`, which is what a Candidate's own selection raises. It never clicks
   * anything and never opens a chooser. The candidate report is read back by
   * name, because a page can clear or replace the selection.
   */
  async function attachDocument(nodes: readonly HTMLElement[], document: EvePageDocument): Promise<boolean> {
    if (nodes.length !== 1) return false
    const input = nodes[0]
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || !input.isConnected || input.disabled) return false
    // The Candidate reviewed a visible uploader; one hidden since then takes no file, as for a typed value.
    if (!controlVisible(input, "file")) return false
    // A page may have changed its accept between the read and the fill.
    if (!acceptsPdf(input)) return false
    let file: File
    try {
      file = documentFile(document)
    } catch {
      return false
    }
    let transferred: FileList
    try {
      const transfer = new DataTransfer()
      transfer.items.add(file)
      transferred = transfer.files
    } catch {
      return false
    }
    try {
      input.files = transferred
    } catch {
      return false
    }
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
    await nextFrame()
    return input.files?.[0]?.name === document.name
  }

  /** Arms the page for one stepped run: a previous run's outlines go before the first item. */
  function begin(): void {
    clearOutlines()
  }

  /** One planned value, by the ref the last read gave it. A ref that is not on the page false, touching nothing. */
  async function fillValue(value: EvePageValue): Promise<boolean> {
    if (!REF_PATTERN.test(value.ref)) return false
    return setValue(refs.get(value.ref) ?? [], value)
  }

  /** One planned document, by the ref the last read gave its file input. */
  async function attachFile(document: EvePageDocument): Promise<boolean> {
    if (!REF_PATTERN.test(document.ref)) return false
    return attachDocument(refs.get(document.ref) ?? [], document)
  }

  /** After the last item: outline the required fields still empty, and count them once per field. */
  function finish(): EvePageFinishResult {
    return { unanswered: outlineRequired() }
  }

  async function fill(payload: EvePageFillPayload): Promise<EvePageFillResult> {
    begin()
    const mismatched: string[] = []
    let filled = 0
    for (const value of payload.values) {
      if (await fillValue(value)) filled++
      else mismatched.push(value.ref)
    }
    let attached = 0
    for (const document of payload.documents ?? []) {
      if (await attachFile(document)) attached++
      else mismatched.push(document.ref)
    }
    return { filled, attached, unanswered: finish().unanswered, mismatched }
  }

  globalThis.__evePage = { read, begin, fillValue, attachFile, finish, fill }
})()
