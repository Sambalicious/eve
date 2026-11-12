/**
 * Fixed, read-only page scripts run through `browser_evaluate` (architecture
 * r1 journey 2 step 3). They are constants: no model-written or page-written
 * text is ever spliced into them. `READ_FORM` tags each control of the form
 * that holds the submit control with `data-ja-ref` so later calls target it by
 * a backend-chosen selector, and tags the single submit control with
 * `data-ja-submit` when exactly one exists.
 */
/**
 * F-QA5E-01: the question text of a label, legend or labelling element without
 * the text of controls nested in it (Lever puts the select inside its label,
 * so innerText would end in "Please select Yes No"). Hidden nodes are skipped
 * and whitespace is collapsed. It runs in the page through `toString()`, so it
 * uses only DOM members and no imports or closures.
 */
export function labelText(el: LabelNode | null | undefined): string {
  if (!el) return ""
  const skip = /^(select|option|optgroup|datalist|input|textarea|button|script|style|template|noscript)$/i
  const parts: string[] = []
  const walk = (node: LabelNode): void => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue || "")
      return
    }
    if (node.nodeType !== 1) return
    // A skipped node still separates the words around it.
    parts.push(" ")
    if (skip.test(node.tagName || "")) return
    const role = (node.getAttribute && node.getAttribute("role")) || ""
    if (/^(listbox|option|combobox|button|textbox|radio|checkbox)$/i.test(role)) return
    if (node.getAttribute && (node.getAttribute("hidden") !== null || node.getAttribute("aria-hidden") === "true")) return
    if (typeof node.checkVisibility === "function" && !node.checkVisibility()) return
    for (const child of Array.from(node.childNodes || [])) walk(child)
    parts.push(" ")
  }
  walk(el)
  return parts.join("").replace(/\s+/g, " ").trim()
}

/** The DOM members `labelText` reads. */
export type LabelNode = Readonly<{
  nodeType: number
  nodeValue?: string | null
  tagName?: string
  childNodes?: ArrayLike<LabelNode>
  getAttribute?: (name: string) => string | null
  checkVisibility?: () => boolean
}>

export const READ_FORM = `() => {
  const text = (el) => (el ? (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim() : "");
  const labelText = ${labelText.toString()};
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const submitsOf = (form) => [...form.querySelectorAll('button, input[type=submit], input[type=image]')]
    .filter((el) => el.tagName !== "BUTTON" || (el.getAttribute("type") || "submit").toLowerCase() === "submit")
    .filter((el) => visible(el) && !el.disabled);
  const forms = [...document.querySelectorAll("form")].filter((form) => submitsOf(form).length > 0);
  const form = forms[0] || null;
  const guard = window.__jaGuard;
  const result = { host: location.host, text: text(document.body).slice(0, 20000), controls: [], values: {}, submitControls: 0, guard: guard ? guard.caught() : -1 };
  if (!form) return result;
  const submits = submitsOf(form);
  result.submitControls = forms.length === 1 ? submits.length : submits.length + 1;
  document.querySelectorAll("[data-ja-submit]").forEach((el) => el.removeAttribute("data-ja-submit"));
  if (submits.length === 1) submits[0].setAttribute("data-ja-submit", "1");
  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria.replace(/\\s+/g, " ").trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) return by.split(/\\s+/).map((id) => labelText(document.getElementById(id))).join(" ").replace(/\\s+/g, " ").trim();
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return labelText(l); }
    const wrap = el.closest("label"); if (wrap) return labelText(wrap);
    const set = el.closest("fieldset"); if (set) return labelText(set.querySelector("legend"));
    return el.getAttribute("placeholder") || el.name || "";
  };
  // SEC-513: every other reading of the label, and flags for content labelText may not show.
  const squash = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const visibleBox = (node) => (typeof node.checkVisibility === "function" ? node.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : true) && parseFloat(getComputedStyle(node).fontSize || "16") >= 6;
  const quietPseudo = (node, which) => { const c = getComputedStyle(node, which).content; return !c || c === "none" || c === "normal" || /^(["'])\\s*\\*?\\s*\\1$/.test(c); };
  const checkOf = (el, radio) => {
    const sources = [];
    const add = (node) => { if (node && !sources.includes(node)) sources.push(node); };
    const by = el.getAttribute("aria-labelledby");
    if (by) by.split(/\\s+/).forEach((id) => add(document.getElementById(id)));
    const set = el.closest("fieldset");
    if (radio && set) add(set.querySelector("legend"));
    if (!radio) { [...(el.labels || [])].forEach(add); add(el.closest("label")); if (sources.length === 0 && set) add(set.querySelector("legend")); }
    const readings = [];
    const flags = new Set();
    const aria = el.getAttribute("aria-label");
    if (aria) readings.push(aria.replace(/\\s+/g, " ").trim());
    const own = text(el);
    for (const source of sources) {
      const shown = text(source);
      readings.push(source.contains(el) && own ? shown.replace(own, " ").replace(/\\s+/g, " ").trim() : shown);
      const r = source.getBoundingClientRect();
      if (!visibleBox(source) || r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= document.documentElement.scrollWidth) flags.add("offscreen_source");
      for (const node of [source, ...source.querySelectorAll("*")]) {
        if (node !== source && el.contains(node)) continue;
        if (node === el) continue;
        if (node !== source && (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true")) flags.add("hidden_node");
        if (node !== source && node.hasAttribute("role") && /^(button|link|listbox|option|combobox|textbox|radio|checkbox|switch|menu|menuitem|tab|slider|spinbutton|searchbox)$/i.test(node.getAttribute("role").trim())) flags.add("interactive_role");
        if (/^(input|select|textarea|button|option|optgroup|datalist|output|meter|progress|object|iframe|embed|canvas|img|svg)$/i.test(node.tagName)) flags.add("nested_control");
        if (node.isContentEditable && node !== source) flags.add("nested_control");
        if (node.shadowRoot || node.tagName.includes("-")) flags.add("shadow");
        if (!quietPseudo(node, "::before") || !quietPseudo(node, "::after")) flags.add("pseudo_content");
        if (node !== source && !visibleBox(node)) flags.add("hidden_node");
        const box = node.getBoundingClientRect();
        if (node.children.length === 0 && !(node.textContent || "").trim() && box.width > 1 && box.height > 1) flags.add("opaque_content");
        if ((node.textContent || "").trim() && !text(node) && box.width > 1) flags.add("opaque_content");
        // A closed shadow root hides its host's light text (no rects) and shows its own (opaque_content above).
        for (const child of node.childNodes) {
          if (child.nodeType !== 3 || !(child.nodeValue || "").trim()) continue;
          const range = document.createRange(); range.selectNodeContents(child);
          if (range.getClientRects().length === 0) flags.add("hidden_node");
        }
      }
    }
    if (aria && sources.length > 0) { const visibleLabel = squash(sources.map((s) => labelText(s)).join(" ")); if (visibleLabel && visibleLabel !== squash(aria)) flags.add("aria_override"); }
    return { readings, flags: [...flags] };
  };
  let n = 0;
  const radios = new Map();
  for (const el of form.querySelectorAll("input, textarea, select")) {
    const type = (el.getAttribute("type") || (el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : "text")).toLowerCase();
    if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;
    if (type === "radio") {
      const name = el.name || "radio" + n;
      if (!radios.has(name)) {
        const ref = "r" + n++;
        const set = el.closest("fieldset");
        const label = set ? labelText(set.querySelector("legend")) : labelOf(el);
        radios.set(name, { ref, options: [] });
        result.controls.push({ ref, label, kind: "radio", required: el.required, options: radios.get(name).options, labelCheck: checkOf(el, true), fieldName: el.name || "", fieldId: "" });
        result.values[ref] = "";
      }
      const group = radios.get(name);
      el.setAttribute("data-ja-ref", group.ref);
      const option = (el.id && text(document.querySelector('label[for="' + CSS.escape(el.id) + '"]'))) || text(el.closest("label")) || el.value;
      el.setAttribute("data-ja-option", option);
      group.options.push(option);
      if (el.checked) result.values[group.ref] = option;
      continue;
    }
    const ref = "f" + n++;
    el.setAttribute("data-ja-ref", ref);
    const kind = type === "select" ? "select" : type === "textarea" ? "textarea" : type === "checkbox" ? "checkbox" : type === "file" ? "file" : "text";
    const control = { ref, label: labelOf(el), kind, required: el.required || el.getAttribute("aria-required") === "true", labelCheck: checkOf(el, false), fieldName: el.name || "", fieldId: el.id || "" };
    if (kind === "text" && ((el.getAttribute("role") || "").trim().toLowerCase() === "combobox" || el.hasAttribute("list") || !/^(none|)$/i.test((el.getAttribute("aria-autocomplete") || "").trim()))) control.combobox = true;
    if (kind === "select") control.options = [...el.options].map((o) => o.text.trim()).filter((t) => t !== "").slice(0, 200);
    result.controls.push(control);
    result.values[ref] = kind === "select" ? (el.selectedIndex > 0 || (el.selectedIndex === 0 && el.options[0].value !== "") ? el.options[el.selectedIndex].text.trim() : "")
      : kind === "checkbox" ? (el.checked ? "true" : "")
      : kind === "file" ? (el.files && el.files[0] ? el.files[0].name : "")
      : el.value;
  }
  return result;
}`

/** The page's host only, after a call. */
export const READ_HOST = `() => location.host`

/**
 * The page after the submit click, for evidence parsing in code (SEC-501,
 * SEC-502): host, visible text with line breaks, whether the application form
 * is still there (the tagged submit control or field, or any form with fields
 * and a submit control), and whether a field shows a validation error.
 */
export const READ_RESULT = `() => {
  const formPresent = !!document.querySelector("[data-ja-submit], [data-ja-ref]") || [...document.querySelectorAll("form")].some((form) =>
    form.querySelector("input:not([type=hidden]):not([type=submit]):not([type=button]), textarea, select") && form.querySelector('button[type=submit], button:not([type]), input[type=submit]'));
  const validationErrors = !!document.querySelector('[aria-invalid="true"], [role="alert"]:not(:empty), .error:not(:empty), .field-error:not(:empty), .invalid-feedback:not(:empty)');
  return { host: location.host, text: (document.body ? (document.body.innerText || "") : "").slice(0, 20000), formPresent, validationErrors };
}`

/** Opens the submit guard's one-shot gate (submit fence part 2). False when the guard is missing. */
export const OPEN_GUARD = `() => (window.__jaGuard ? window.__jaGuard.open() : false)`

/** Selector for a control tagged by READ_FORM. Refs are backend-made (`f12`, `r3`), checked before use. */
export function refSelector(ref: string): string {
  if (!/^[fr]\d{1,4}$/.test(ref)) throw new Error("Invalid form ref")
  return `[data-ja-ref="${ref}"]`
}

export const SUBMIT_SELECTOR = "[data-ja-submit]"
