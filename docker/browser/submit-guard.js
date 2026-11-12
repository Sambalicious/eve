// Submit guard (ADR 0008 submit fence part 1; architecture r1 journey 2 step 2).
// Loaded on every page by Playwright MCP `--init-script`. Until the backend
// opens the one-shot gate, it cancels every form `submit` event, every click
// on a submit-type control, and `form.submit()`, and records each attempt.
// The gate lets exactly one click and one resulting submit through, then
// closes for good. This stops agent and page mistakes; it is not a security
// boundary against a hostile page, which controls its own DOM.
;(() => {
  if (window.__jaGuard) return
  let caught = 0
  let clicks = 0
  let submits = 0
  const isSubmitControl = (el) => {
    if (!(el instanceof Element)) return false
    const control = el.closest("button, input[type=submit], input[type=image]")
    if (!control) return false
    if (control.tagName === "BUTTON") {
      const type = (control.getAttribute("type") || "submit").toLowerCase()
      return type === "submit" && control.closest("form") !== null
    }
    return true
  }
  const record = (event) => {
    caught += 1
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  window.addEventListener(
    "click",
    (event) => {
      if (!isSubmitControl(event.target)) return
      if (clicks > 0) {
        clicks -= 1
        return
      }
      record(event)
    },
    true
  )
  window.addEventListener(
    "submit",
    (event) => {
      if (submits > 0) {
        submits -= 1
        return
      }
      record(event)
    },
    true
  )
  const nativeSubmit = HTMLFormElement.prototype.submit
  Object.defineProperty(HTMLFormElement.prototype, "submit", {
    configurable: false,
    writable: false,
    value: function submit() {
      if (submits > 0) {
        submits -= 1
        return nativeSubmit.call(this)
      }
      caught += 1
    },
  })
  Object.defineProperty(window, "__jaGuard", {
    configurable: false,
    writable: false,
    value: Object.freeze({
      caught: () => caught,
      open: () => {
        clicks = 1
        submits = 1
        return true
      },
    }),
  })
})()
