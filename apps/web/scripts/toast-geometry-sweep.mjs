#!/usr/bin/env node
/**
 * EPIC-F2 toast geometry sweep: every acceptance case in
 * epics/active/EPIC-F2-mobile-toast/design-spec.r1.md, plus the motion timing
 * cases (M, R) in design-spec.r2.md, measured in Chromium.
 *
 *   pnpm --filter @eve/web sweep:toast
 *
 * Starts the committed stub (scripts/toast-sweep-stub.mjs) and a Vite dev
 * server on free 127.0.0.1 ports, runs the cases, prints one table row per
 * case, stops both, and exits 1 if any case fails. Nothing is left running,
 * also on failure or Ctrl-C.
 *
 * One-time setup: playwright-core is a pinned devDependency (1.64.1). Its
 * Chromium build is not installed by `pnpm install`; if it is missing, run
 *   pnpm --filter @eve/web exec playwright-core install chromium
 *
 * Environment (all optional overrides):
 *   TOAST_SWEEP_STUB       stub server path (default: scripts/toast-sweep-stub.mjs)
 *   PLAYWRIGHT_CORE_PATH   a playwright-core package directory (default: the pinned
 *                          devDependency, by normal module resolution)
 *   TOAST_SWEEP_HEADED=1   show the browser
 *
 * Port to Sonner (EPIC-0003): selectors read Sonner's DOM ([data-sonner-toast],
 * data-y-position, data-removed) and the region is named "Messages"
 * (app.toast.region_label). The measured cases and their thresholds are F2's.
 * Motion timing (F2 r2, Candidate decision 2026-10-22 21:28): the exit signal
 * is Sonner's data-removed="true" (Base UI's data-ending-style), the content
 * layer is the toast's first child ([data-content]), the close control is
 * "Close message", and Sonner has no --enter-distance variable.
 *
 * Test double: the stub implements only PUT /v1/candidate-settings/job-criteria.
 * Work authorization and Contact details saves get a 404, so they show the
 * error toast (taller than "Saved."). Placement is the same for both.
 */
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { existsSync, readFileSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SECTIONS = ["Location and work authorization", "Job criteria", "Contact details"]
const SHORT = { "Location and work authorization": "Work auth", "Job criteria": "Job criteria", "Contact details": "Contact" }
const BLOCK = { top: "start", middle: "center", bottom: "end" }
const SETTLE_MS = 1500
const MEASURE_MS = 800
/** DESIGN.md:51 ease-out, as a browser serialises it, whitespace removed (design-spec.r2 `E`). */
const EASE = "cubic-bezier(0.25,1,0.5,1)"
/** design-spec.r2: an exiting node is removed within its 150ms exit plus 100ms. */
const REMOVE_WITHIN_MS = 250
/** design-spec.r2: the enter transition is read within the next 2 frames after insert. */
const ENTER_FRAMES = 2

// ---------------------------------------------------------------- processes

const children = []

function stopAll() {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null) continue
    try {
      process.kill(-child.pid, "SIGTERM")
    } catch {
      /* already gone */
    }
  }
}
process.on("exit", stopAll)
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function start(command, args, env, readyText, label) {
  const child = spawn(command, args, { cwd: WEB_DIR, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  children.push(child)
  let log = ""
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} not ready in 60 s:\n${log}`)), 60_000)
    const onData = (chunk) => {
      log += chunk
      if (log.includes(readyText)) {
        clearTimeout(timer)
        resolve(child)
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`${label} exited (${code}):\n${log}`))
    })
  })
}

function stubPath() {
  return process.env.TOAST_SWEEP_STUB || path.join(WEB_DIR, "scripts/toast-sweep-stub.mjs")
}

/** The pinned devDependency, or PLAYWRIGHT_CORE_PATH. No fallback: a failure is reported, not skipped. */
async function loadPlaywright() {
  const override = process.env.PLAYWRIGHT_CORE_PATH
  let dir
  try {
    dir = override ? path.resolve(override) : path.dirname(createRequire(import.meta.url).resolve("playwright-core/package.json"))
  } catch {
    throw new Error("playwright-core not installed. Run `pnpm install`, or set PLAYWRIGHT_CORE_PATH.")
  }
  try {
    const { version } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
    return { ...(await import(pathToFileURL(path.join(dir, "index.mjs")).href)), dir, version, override: Boolean(override) }
  } catch (error) {
    throw new Error(`cannot load playwright-core from ${dir}: ${error.message}`)
  }
}

// ---------------------------------------------------------------- page helpers

let base = ""
let stub = ""

async function setStub(params) {
  const res = await fetch(`${stub}/__stub?${new URLSearchParams(params)}`)
  if (!res.ok) throw new Error(`stub config failed: ${res.status}`)
}

async function openSettings(page) {
  await page.goto(`${base}/settings`, { waitUntil: "networkidle" })
  await page.getByRole("region", { name: "Contact details" }).getByRole("button", { name: "Save changes" }).waitFor()
  await page.waitForTimeout(SETTLE_MS)
}

function saveButton(page, section) {
  return page.getByRole("region", { name: section }).locator('button[type="submit"]')
}

async function scrollTo(button, position) {
  await button.evaluate((el, block) => el.scrollIntoView({ block, behavior: "instant" }), BLOCK[position])
  await button.page().waitForTimeout(250)
}

/** Header bottom, content-area mid and viewport size, from the live page. */
function layout(page) {
  return page.evaluate(() => {
    const header = document.querySelector("header.app-header")
    const headerBottom = header ? header.getBoundingClientRect().bottom : 0
    const h = window.visualViewport?.height ?? innerHeight
    return { headerBottom, mid: (headerBottom + h) / 2, vw: innerWidth, vh: innerHeight }
  })
}

const rectOf = (handle) => handle.evaluate((el) => el.getBoundingClientRect().toJSON())

async function activate(button, input) {
  if (input === "Enter") {
    await button.evaluate((el) => el.focus({ preventScroll: true }))
    await button.page().keyboard.press("Enter")
  } else if (input === "tap") {
    await button.tap()
  } else {
    await button.click()
  }
}

/** Live (not exiting) toasts, plus overlap with the pressed button, its form's errors and other controls. */
function measure(page, buttonHandle) {
  return page.evaluate((pressed) => {
    const box = (e) => e.getBoundingClientRect()
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
    const toasts = [...document.querySelectorAll('[data-sonner-toast]')]
      .filter((t) => t.getAttribute("data-removed") !== "true")
      .map((t) => ({ el: t, r: box(t), position: t.dataset.yPosition, text: t.textContent.trim() }))
    const viewport = document.querySelector('[data-sonner-toaster]')
    const form = pressed.closest("form")
    const errors = form ? [...form.querySelectorAll('[data-slot="alert"], [data-slot="field-error"]')].map(box).filter((r) => r.width > 0) : []
    const pr = box(pressed)
    const others = [...document.querySelectorAll("button, a, [role=button], input, textarea, select")]
      .filter((c) => c !== pressed && !c.closest('[data-sonner-toaster]'))
      .map((c) => ({ name: (c.getAttribute("aria-label") || c.textContent || c.getAttribute("placeholder") || c.tagName).trim().slice(0, 24), r: box(c) }))
      .filter((c) => c.r.width > 0 && c.r.bottom > 0 && c.r.top < innerHeight)
    return {
      count: toasts.length,
      toast: toasts[0] && { top: toasts[0].r.top, bottom: toasts[0].r.bottom, left: toasts[0].r.left, right: toasts[0].r.right, width: toasts[0].r.width, position: toasts[0].position, text: toasts[0].text },
      viewportPosition: viewport?.dataset.yPosition,
      pressed: pr.toJSON(),
      pressedHit: toasts.some((t) => hit(t.r, pr)),
      errorRects: errors.length,
      errorHit: toasts.some((t) => errors.some((e) => hit(t.r, e))),
      othersHit: [...new Set(others.filter((c) => toasts.some((t) => hit(t.r, c.r))).map((c) => c.name))],
    }
  }, buttonHandle)
}

async function waitForToast(page, text) {
  const sel = text ? `[data-sonner-toast]:not([data-removed="true"]):has-text("${text}")` : '[data-sonner-toast]:not([data-removed="true"])'
  await page.locator(sel).first().waitFor({ state: "visible", timeout: 15_000 })
}

const near = (a, b, tol = 1) => Math.abs(a - b) <= tol
const r0 = (n) => Math.round(n)

// ---------------------------------------------------------------- motion timing (design-spec.r2)

/**
 * Runs in the page. Installs `window.__toastTiming(el)` and a recorder,
 * `window.__toastRec`, that a MutationObserver fills for every toast: `enter`
 * (first frame with a running transform transition, read for up to 10 frames),
 * `reflow` (the same, on older toasts when a newer one is inserted, plus their
 * content), the timing at the moment `data-removed` turns "true" (key
 * `removed`, Base UI's `data-ending-style`), `data-orphaned` and
 * `data-swipe-direction` appear, and `removedAt`. Timing is per layer from
 * `el.getAnimations()` (CSSTransition) where one runs, else from the computed
 * transition longhands; a shorter duration or easing list repeats per CSS.
 */
function installMotionRecorder() {
  const norm = (v) => (v || "").replace(/\s+/g, "")
  const toMs = (d) => {
    const v = String(d).trim()
    return Math.round((v.endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000) * 1000) / 1000
  }
  const splitTop = (value) => {
    const parts = []
    let depth = 0
    let current = ""
    for (const ch of value) {
      if (ch === "(") depth++
      if (ch === ")") depth--
      if (ch === "," && depth === 0) {
        parts.push(current.trim())
        current = ""
      } else current += ch
    }
    parts.push(current.trim())
    return parts
  }
  const timing = (el) => {
    const cs = getComputedStyle(el)
    const css = { property: cs.transitionProperty, duration: cs.transitionDuration, easing: cs.transitionTimingFunction }
    const props = splitTop(css.property)
    const durs = splitTop(css.duration)
    const eases = splitTop(css.easing)
    const layers = props.map((property, i) => ({ property, ms: toMs(durs[i % durs.length]), easing: norm(eases[i % eases.length]), src: "css" }))
    for (const a of el.getAnimations()) {
      if (typeof CSSTransition === "undefined" || !(a instanceof CSSTransition) || a.effect?.target !== el) continue
      const t = a.effect.getTiming()
      let easing = norm(t.easing)
      if (easing === "linear") easing = norm(a.effect.getKeyframes()[0]?.easing) || easing
      const entry = { property: a.transitionProperty, ms: toMs(`${t.duration}ms`), easing, src: "anim", state: a.playState }
      const i = layers.findIndex((l) => l.property === entry.property)
      if (i >= 0) layers[i] = entry
      else layers.push(entry)
    }
    return { css, layers }
  }
  window.__toastTiming = timing
  const rec = { toasts: [] }
  window.__toastRec = rec
  const entryFor = (el) => {
    if (!el.__motion) {
      el.__motion = { n: rec.toasts.length, text: el.textContent.trim().slice(0, 40), position: el.dataset.yPosition, addedAt: performance.now() }
      rec.toasts.push(el.__motion)
    }
    return el.__motion
  }
  const hasTransform = (t) => t.layers.some((l) => l.property === "transform" && l.src === "anim")
  const watchFrames = (el, key, withContent) => {
    let frame = 0
    const tick = () => {
      frame++
      const t = timing(el)
      if (hasTransform(t) || frame >= 10 || !el.isConnected) {
        const content = el.firstElementChild
        entryFor(el)[key] = { frame, found: hasTransform(t), ...t, content: withContent && content ? timing(content) : null }
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  const toastsIn = (node) =>
    node.nodeType !== 1 ? [] : node.matches("[data-sonner-toast]") ? [node] : [...node.querySelectorAll("[data-sonner-toast]")]
  // Sonner always renders data-removed; it counts when it turns "true".
  const appeared = (m) =>
    m.attributeName === "data-removed"
      ? m.oldValue !== "true" && m.target.getAttribute("data-removed") === "true"
      : m.oldValue === null && m.target.hasAttribute(m.attributeName)
  const animation = (el) => {
    const cs = getComputedStyle(el)
    return { name: cs.animationName, duration: cs.animationDuration, easing: norm(cs.animationTimingFunction) }
  }
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "childList") {
        for (const node of m.addedNodes)
          for (const el of toastsIn(node)) {
            const older = [...document.querySelectorAll("[data-sonner-toast]")].filter((t) => t !== el && t.getAttribute("data-removed") !== "true")
            entryFor(el)
            watchFrames(el, "enter", false)
            for (const o of older) watchFrames(o, "reflow", true)
          }
        for (const node of m.removedNodes) for (const el of toastsIn(node)) if (el.__motion) el.__motion.removedAt = performance.now()
      } else if (m.target.matches?.("[data-sonner-toast]") && appeared(m)) {
        const e = entryFor(m.target)
        const key = m.attributeName.replace("data-", "")
        if (!e[key])
          e[key] = { at: performance.now(), ...timing(m.target), transform: getComputedStyle(m.target).transform, swipeDirection: m.target.dataset.swipeDirection ?? null, animation: animation(m.target) }
      }
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["data-removed", "data-orphaned", "data-swipe-direction"],
  })
}

const motionRecord = (page) => page.evaluate(() => window.__toastRec)
const layerOf = (t, property) => t?.layers.find((l) => l.property === property)
const layersText = (t) => (t ? t.layers.map((l) => `${l.property} ${l.ms}${l.src === "anim" ? "*" : ""}`).join(", ") : "none")

/** Pushes a failure for each expected `property: ms` that is missing, off-duration or off-curve. */
function expectLayers(f, t, expected, label) {
  if (!t) return f.push(`${label}: not recorded`)
  for (const [property, ms] of Object.entries(expected)) {
    const l = layerOf(t, property)
    if (!l) f.push(`${label}: no ${property} layer (${layersText(t)})`)
    else {
      if (l.ms !== ms) f.push(`${label}: ${property} ${l.ms}ms, expected ${ms}`)
      if (l.easing !== EASE) f.push(`${label}: ${property} easing ${l.easing}`)
    }
  }
}

/** Every computed layer has this duration and the DESIGN.md curve; transition-property is exactly `properties`. */
function expectComputed(f, t, properties, ms, label) {
  if (!t) return f.push(`${label}: not recorded`)
  const got = t.css.property.split(",").map((p) => p.trim())
  if (got.join(", ") !== properties.join(", ")) f.push(`${label}: transition-property ${t.css.property}`)
  for (const l of t.layers.filter((layer) => layer.src === "css")) {
    const want = Array.isArray(ms) ? ms[properties.indexOf(l.property)] : ms
    if (l.ms !== want) f.push(`${label}: ${l.property} ${l.ms}ms, expected ${want}`)
    if (l.easing !== EASE) f.push(`${label}: ${l.property} easing ${l.easing}`)
  }
}

function expectRemoved(f, entry, from, label) {
  if (!entry?.removedAt) return f.push(`${label}: node not removed`)
  const ms = entry.removedAt - from
  if (ms > REMOVE_WITHIN_MS) f.push(`${label}: removed ${r0(ms)}ms after, limit ${REMOVE_WITHIN_MS}`)
}

/** Computed-only timing: layers as the stylesheet declares them, ignoring running animations. */
function cssOnly(t) {
  if (!t) return t
  const props = t.css.property.split(",").map((p) => p.trim())
  const durs = t.css.duration.split(",").map((d) => d.trim())
  const eases = t.css.easing.match(/[\w-]+\([^)]*\)|[^,\s]+/g) ?? []
  const toMs = (d) => Math.round((d.endsWith("ms") ? parseFloat(d) : parseFloat(d) * 1000) * 1000) / 1000
  return { css: t.css, layers: props.map((property, i) => ({ property, ms: toMs(durs[i % durs.length]), easing: (eases[i % eases.length] ?? "").replace(/\s+/g, ""), src: "css" })) }
}

// ---------------------------------------------------------------- cases

const results = []
function record(id, scenario, caseName, failures, detail, info = "") {
  results.push({ id, scenario, caseName, pass: failures.length === 0, detail: failures.length ? failures.join("; ") : detail, info })
}

async function placementCase(browser, id, size, section, position, input) {
  const [w, h] = size.split("x").map(Number)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true })
  const page = await ctx.newPage()
  try {
    await setStub({ put: "ok", putDelay: "0" })
    await openSettings(page)
    const button = saveButton(page, section)
    await scrollTo(button, position)
    const L = await layout(page)
    const before = await rectOf(button)
    const centerY = (before.top + before.bottom) / 2
    const expected = centerY >= L.mid ? "top" : "bottom"
    const handle = await button.elementHandle()
    await activate(button, input)
    await waitForToast(page)
    await page.waitForTimeout(MEASURE_MS)
    const m = await measure(page, handle)
    const f = []
    if (m.count !== 1) f.push(`${m.count} toasts visible`)
    if (m.toast) {
      if (m.pressedHit) f.push(`covers pressed button (${r0(m.pressed.top)}-${r0(m.pressed.bottom)})`)
      if (m.toast.position !== expected) f.push(`position ${m.toast.position}, expected ${expected} (centre ${r0(centerY)}, mid ${r0(L.mid)})`)
      if (m.toast.position === "top" && m.toast.top < L.headerBottom + 8 - 0.5) f.push(`top ${r0(m.toast.top)} < header ${r0(L.headerBottom)}+8`)
      if (m.toast.position === "bottom" && m.toast.bottom > L.vh - 16 + 0.5) f.push(`bottom ${r0(m.toast.bottom)} > ${L.vh}-16`)
      if (!near(m.toast.left, 16) || !near(m.toast.right, L.vw - 16)) f.push(`x ${r0(m.toast.left)}-${r0(m.toast.right)}, expected 16-${L.vw - 16}`)
    }
    const t = m.toast
    record(
      id,
      "Clear of pressed Save",
      `${size} ${SHORT[section]} ${position} ${input}`,
      f,
      t ? `btn ${r0(before.top)}-${r0(before.bottom)} mid ${r0(L.mid)} → ${t.position} ${r0(t.top)}-${r0(t.bottom)}` : "",
      m.othersHit.length ? `covers other: ${m.othersHit.join(", ")}` : ""
    )
  } catch (error) {
    record(id, "Clear of pressed Save", `${size} ${SHORT[section]} ${position} ${input}`, [String(error.message).split("\n")[0]], "")
  } finally {
    await ctx.close()
  }
}

async function savedThenErrorCase(browser, id, size, position) {
  const [w, h] = size.split("x").map(Number)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true })
  const page = await ctx.newPage()
  const caseName = `${size} Job criteria ${position}`
  try {
    await setStub({ put: "ok", putDelay: "0" })
    await openSettings(page)
    const button = saveButton(page, "Job criteria")
    await scrollTo(button, position)
    const handle = await button.elementHandle()
    await button.tap()
    await waitForToast(page, "Saved.")
    const saved = page.locator('[data-sonner-toast]', { hasText: "Saved." }).first()
    await page.waitForTimeout(300)
    await setStub({ put: "500", putDelay: "300" })
    await button.tap()
    // Rule 4: the old toast starts closing on the press, before the response.
    // Sonner commits a dismiss on the next animation frame, so allow 250 ms
    // (still before the 300 ms delayed response) for data-removed to appear.
    const closedOnPress = await saved
      .evaluate((el) => new Promise((resolve) => {
        const t0 = performance.now()
        const tick = () => (el.getAttribute("data-removed") === "true" || !el.isConnected ? resolve(true) : performance.now() - t0 > 250 ? resolve(false) : requestAnimationFrame(tick))
        tick()
      }))
      .catch(() => true)
    const form = page.getByRole("region", { name: "Job criteria" }).locator("form")
    await form.locator('[data-slot="alert"]').first().waitFor({ state: "visible", timeout: 10_000 })
    await page.waitForTimeout(MEASURE_MS)
    const m = await measure(page, handle)
    const f = []
    if (!closedOnPress) f.push("Saved. still live after the second press")
    if (m.pressedHit) f.push("toast covers pressed button")
    if (m.errorHit) f.push("toast covers inline error")
    if (m.errorRects === 0) f.push("no inline error rendered")
    record(id, "Saved then error", caseName, f, `closed on press; ${m.count} toast(s) after error; ${m.errorRects} error rect(s) clear`)
  } catch (error) {
    record(id, "Saved then error", caseName, [String(error.message).split("\n")[0]], "")
  } finally {
    await ctx.close()
  }
}

async function noTriggerCase(browser, id) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true })
  const page = await ctx.newPage()
  try {
    // Press Job criteria Save from the upper half (would place the toast at the
    // bottom), but answer after more than 10 s, so the press no longer counts.
    await setStub({ put: "ok", putDelay: "10500" })
    await openSettings(page)
    const button = saveButton(page, "Job criteria")
    await scrollTo(button, "top")
    await button.tap()
    await waitForToast(page, "Saved.")
    const m = await measure(page, await button.elementHandle())
    const f = m.toast?.position === "top" ? [] : [`position ${m.toast?.position}`]
    record(id, "No recent trigger → top", "375x812 answer after 10.5 s", f, `upper-half press 10.5 s earlier → ${m.toast?.position}`)
  } catch (error) {
    record(id, "No recent trigger → top", "375x812 answer after 10.5 s", [String(error.message).split("\n")[0]], "")
  } finally {
    await setStub({ putDelay: "0" })
    await ctx.close()
  }
}

async function swipeCase(browser, id, position, mid) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true })
  const page = await ctx.newPage()
  const dir = position === "top" ? -1 : 1
  try {
    await setStub({ put: "ok", putDelay: "0" })
    await openSettings(page)
    const button = saveButton(page, "Job criteria")
    await scrollTo(button, position === "top" ? "bottom" : "top")
    await button.tap()
    await waitForToast(page, "Saved.")
    await page.waitForTimeout(MEASURE_MS)
    const toast = page.locator('[data-sonner-toast]').first()
    const got = await toast.getAttribute("data-y-position")
    await page.evaluate(installMotionRecorder)
    const b = await toast.boundingBox()
    const x = b.x + 60
    // Start near the edge away from the swipe: a bottom toast sits 16px above the
    // viewport edge and Chromium sends no pointer events past it, so a drag from
    // the centre could not travel Sonner's 45px threshold (Base UI's was lower).
    const y = dir > 0 ? b.y + 8 : b.y + b.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    // Keep the drag inside the viewport (Chromium drops moves past its edge); 8 steps, at least 48px.
    const step = dir > 0 ? Math.min(15, Math.floor((page.viewportSize().height - 1 - y) / 8)) : 15
    let drag = null
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(x, y + dir * i * step)
      if (i === 4) drag = await toast.evaluate((el) => window.__toastTiming(el))
    }
    await page.mouse.up()
    await page.waitForTimeout(900)
    const left = await page.locator('[data-sonner-toast]:not([data-removed="true"])').count()
    const f = []
    if (got !== position) f.push(`toast was ${got}`)
    if (left !== 0) f.push(`${left} toast(s) still live`)
    record(id, "Swipe dismiss", `375x812 ${position} toast, swipe ${dir < 0 ? "up" : "down"}`, f, `${position} toast dismissed`)
    if (mid) {
      const swipeName = `375x812 ${position} toast, swipe ${dir < 0 ? "up" : "down"}`
      const fd = drag?.css.duration === "0s" ? [] : [`transition-duration ${drag?.css.duration} during drag`]
      record(mid(), "Motion timing", `swipe drag ${swipeName}`, fd, `after 4th move: transition ${drag?.css.property} ${drag?.css.duration}`)
      const entry = (await motionRecord(page)).toasts[0]
      const ending = entry?.removed
      const fs = []
      if (!ending) fs.push('data-removed="true" not seen')
      else {
        if (!ending.swipeDirection) fs.push("data-swipe-direction not set at exit")
        expectComputed(fs, cssOnly(ending), ["transform", "opacity", "height"], 150, "exit")
        // Sonner slides a swiped toast on with a keyframe animation (Base UI used the transition).
        if (ending.animation.name === "none") fs.push("no swipe-out animation")
        else {
          if (ending.animation.duration !== "0.15s") fs.push(`swipe-out ${ending.animation.duration}`)
          if (ending.animation.easing !== EASE) fs.push(`swipe-out easing ${ending.animation.easing}`)
        }
        expectRemoved(fs, entry, ending.at, "exit")
      }
      record(
        mid(),
        "Motion timing",
        `swipe dismiss ${swipeName}`,
        fs,
        ending
          ? `dir ${ending.swipeDirection}; ${ending.css.duration} ${ending.css.easing.replace(/\s+/g, "")}; ${ending.animation.name} ${ending.animation.duration}; removed +${r0((entry.removedAt ?? NaN) - ending.at)}ms`
          : ""
      )
    }
  } catch (error) {
    record(id, "Swipe dismiss", `375x812 ${position}`, [String(error.message).split("\n")[0]], "")
  } finally {
    await ctx.close()
  }
}

async function desktopCase(browser, id, width, half) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } })
  const page = await ctx.newPage()
  const caseName = `${width}x900 ${half} half`
  try {
    await setStub({ put: "ok", putDelay: "0" })
    await openSettings(page)
    const button = saveButton(page, "Job criteria")
    await scrollTo(button, half === "upper" ? "top" : "bottom")
    const L = await layout(page)
    const before = await rectOf(button)
    const centerY = (before.top + before.bottom) / 2
    const f = []
    if ((half === "upper") !== centerY < L.mid) f.push(`button centre ${r0(centerY)} not in ${half} half (mid ${r0(L.mid)})`)
    await button.click()
    await waitForToast(page, "Saved.")
    await page.waitForTimeout(MEASURE_MS)
    const m = await measure(page, await button.elementHandle())
    const t = m.toast
    if (t.position !== "bottom") f.push(`position ${t.position}`)
    if (!near(L.vw - t.right, 16)) f.push(`right gap ${r0(L.vw - t.right)}`)
    if (!near(L.vh - t.bottom, 16)) f.push(`bottom gap ${r0(L.vh - t.bottom)}`)
    if (!near(t.width, 384)) f.push(`width ${r0(t.width)}`)
    record(id, "Desktop unchanged", caseName, f, `bottom, gaps ${r0(L.vw - t.right)}/${r0(L.vh - t.bottom)}, width ${r0(t.width)}`, m.othersHit.length ? `covers other: ${m.othersHit.join(", ")}` : "")
  } catch (error) {
    record(id, "Desktop unchanged", caseName, [String(error.message).split("\n")[0]], "")
  } finally {
    await ctx.close()
  }
}

async function screenReaderCase(browser, id, width) {
  const mobile = width < 768
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 812 : 900 }, hasTouch: mobile })
  const page = await ctx.newPage()
  try {
    await setStub({ put: "ok", putDelay: "200" })
    await openSettings(page)
    const f = []
    const jc = saveButton(page, "Job criteria")
    await scrollTo(jc, "bottom")
    await jc.click()
    await waitForToast(page, "Saved.")
    const region = page.getByRole("region", { name: "Messages" })
    if ((await region.getAttribute("aria-live")) !== "polite") f.push("region not aria-live=polite")
    if ((await region.getByText("Saved.").count()) === 0) f.push("Saved. not in the live region")
    // Rule 4 closes the first toast on this press; focus must stay on the button.
    await jc.click()
    await page.waitForTimeout(1500)
    const focusSaved = await jc.evaluate((el) => document.activeElement === el)
    if (!focusSaved) f.push("focus left Job criteria Save after the second press")
    // Error toast: the stub 404s the work authorization PUT. That Save button is
    // `disabled` while saving (no focusableWhenDisabled), so the browser drops its
    // focus on press, before any toast exists. Recorded as info, not a toast failure.
    const wa = saveButton(page, "Location and work authorization")
    await scrollTo(wa, "middle")
    await wa.click()
    const alert = page.getByRole("region", { name: "Messages" }).getByText("Couldn't save your settings")
    await alert.first().waitFor({ state: "attached", timeout: 10_000 })
    const focusWa = await wa.evaluate((el) => document.activeElement === el)
    record(
      id,
      "Screen readers",
      `${width}px`,
      f,
      "polite region has Saved.; error role=alert; Job criteria Save keeps focus after rule 4",
      focusWa ? "" : "Work auth Save loses focus while disabled-saving (form behaviour, pre-existing)"
    )
  } catch (error) {
    record(id, "Screen readers", `${width}px`, [String(error.message).split("\n")[0]], "")
  } finally {
    await ctx.close()
  }
}

async function reducedMotionCase(browser, id, width, position) {
  const mobile = width < 768
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 812 : 900 }, hasTouch: mobile, reducedMotion: "reduce" })
  const page = await ctx.newPage()
  const caseName = `${width}px ${mobile ? position : "bottom"}`
  try {
    await setStub({ put: "ok", putDelay: "0" })
    await openSettings(page)
    const button = saveButton(page, "Job criteria")
    await scrollTo(button, position === "top" ? "bottom" : "top")
    await button.tap().catch(() => button.click())
    await waitForToast(page, "Saved.")
    const s = await page.locator('[data-sonner-toast]').first().evaluate((el) => {
      const cs = getComputedStyle(el)
      return { property: cs.transitionProperty, duration: cs.transitionDuration, easing: cs.transitionTimingFunction, transform: cs.transform, position: el.dataset.yPosition }
    })
    const f = []
    if (s.property !== "opacity") f.push(`transition-property ${s.property}`)
    const ms = Math.max(...s.duration.split(",").map((d) => parseFloat(d) * (d.trim().endsWith("ms") ? 1 : 1000)))
    if (ms !== 150) f.push(`duration ${ms}ms, expected exactly 150`)
    const easing = s.easing.replace(/\s+/g, "")
    if (easing !== EASE) f.push(`easing ${easing}`)
    // Sonner has no --enter-distance variable (Base UI's); "no translate" is read as the computed transform.
    if (s.transform !== "none") f.push(`transform ${s.transform}`)
    if (mobile && s.position !== position) f.push(`toast was ${s.position}`)
    record(id, "Reduced motion", caseName, f, `${s.property} ${ms}ms ${easing}, translate 0`)
  } catch (error) {
    record(id, "Reduced motion", caseName, [String(error.message).split("\n")[0]], "")
  } finally {
    await ctx.close()
  }
}

/** M enter, M resting and M exit for one width and half, from one toast (design-spec.r2). */
async function motionEnterRestExitCase(browser, mid, width, position) {
  const mobile = width < 768
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 812 : 900 }, hasTouch: mobile })
  const page = await ctx.newPage()
  const caseName = `${width}px ${position}`
  const ids = [mid(), mid(), mid()]
  try {
    await setStub({ put: "ok", putDelay: "0" })
    await openSettings(page)
    await page.evaluate(installMotionRecorder)
    const button = saveButton(page, "Job criteria")
    await scrollTo(button, position === "top" ? "bottom" : "top")
    await activate(button, mobile ? "tap" : "click")
    await waitForToast(page, "Saved.")
    await page.waitForTimeout(MEASURE_MS)
    const toast = page.locator('[data-sonner-toast]:not([data-removed="true"])').first()
    const resting = await toast.evaluate((el) => window.__toastTiming(el))
    await toast.getByRole("button", { name: "Close message" }).click()
    await page.waitForTimeout(MEASURE_MS)
    const entry = (await motionRecord(page)).toasts[0]

    const fe = []
    if (entry?.position !== position) fe.push(`toast was ${entry?.position}`)
    const enter = entry?.enter
    if (!enter?.found) fe.push(`no running transform transition in ${enter?.frame ?? 0} frames`)
    else if (enter.frame > ENTER_FRAMES) fe.push(`transform transition first seen in frame ${enter.frame}, expected within ${ENTER_FRAMES}`)
    expectLayers(fe, enter, { transform: 200 }, "enter")
    const enterOpacity = layerOf(enter, "opacity")
    if (enterOpacity?.src === "anim") expectLayers(fe, enter, { opacity: 200 }, "enter")
    record(ids[0], "Motion timing", `enter ${caseName}`, fe, `frame ${enter?.frame}: ${layersText(enter)} (* running)`)

    const fr = []
    expectComputed(fr, cssOnly(resting), ["transform", "opacity", "height"], [200, 200, 150], "resting")
    if (resting.css.duration !== "0.2s, 0.2s, 0.15s") fr.push(`transition-duration ${resting.css.duration}`)
    record(ids[1], "Motion timing", `resting ${caseName}`, fr, `${resting.css.duration}; ${resting.css.easing.replace(/\s+/g, "")}`)

    const fx = []
    const ending = entry?.removed
    if (!ending) fx.push('data-removed="true" not seen')
    else {
      expectComputed(fx, cssOnly(ending), ["transform", "opacity", "height"], 150, "exit")
      expectRemoved(fx, entry, ending.at, "exit")
    }
    record(ids[2], "Motion timing", `exit ${caseName}`, fx, ending ? `${ending.css.duration} per layer; removed +${r0((entry.removedAt ?? NaN) - ending.at)}ms` : "")
  } catch (error) {
    for (const [i, kind] of ["enter", "resting", "exit"].entries()) record(ids[i], "Motion timing", `${kind} ${caseName}`, [String(error.message).split("\n")[0]], "")
  } finally {
    await ctx.close()
  }
}

/** M orphan: a top toast is closed by a submit press and the next toast flips the viewport to the bottom (CR-03). */
async function motionOrphanCase(browser, id) {
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true })
  const page = await ctx.newPage()
  const caseName = "375x812 top → bottom"
  try {
    await setStub({ put: "ok", putDelay: "0" })
    await openSettings(page)
    await page.evaluate(installMotionRecorder)
    const jc = saveButton(page, "Job criteria")
    await scrollTo(jc, "bottom")
    await jc.tap()
    await waitForToast(page, "Saved.")
    const shownAt = Date.now()
    const wa = saveButton(page, "Location and work authorization")
    await scrollTo(wa, "top")
    await wa.tap()
    const tapAfter = Date.now() - shownAt
    await waitForToast(page, "Couldn't save")
    await page.waitForTimeout(MEASURE_MS)
    const rec = await motionRecord(page)
    const first = rec.toasts.find((t) => t.text.startsWith("Saved."))
    const orphaned = first?.orphaned
    const f = []
    if (tapAfter > 1000) f.push(`second tap ${tapAfter}ms after the first toast, limit 1000`)
    if (first?.position !== "top") f.push(`first toast was ${first?.position}`)
    if (!orphaned) f.push(`data-orphaned not seen (first toast removed +${r0((first?.removedAt ?? NaN) - (first?.removed?.at ?? NaN))}ms after exit start)`)
    else {
      expectComputed(f, cssOnly(orphaned), ["opacity"], 150, "orphan")
      if (orphaned.transform !== "none") f.push(`transform ${orphaned.transform}`)
      expectRemoved(f, first, orphaned.at, "orphan")
    }
    record(
      id,
      "Motion timing",
      `orphan ${caseName}`,
      f,
      orphaned
        ? `${orphaned.css.property} ${orphaned.css.duration} ${orphaned.css.easing.replace(/\s+/g, "")}, transform ${orphaned.transform}; removed +${r0(first.removedAt - orphaned.at)}ms after orphan`
        : ""
    )
  } catch (error) {
    record(id, "Motion timing", `orphan ${caseName}`, [String(error.message).split("\n")[0]], "")
  } finally {
    await ctx.close()
  }
}

/** M reflow: two toasts 300ms apart at 1280x900; the older one's stack transitions. */
async function motionReflowCase(browser, id) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  const caseName = "1280x900 two toasts 300ms apart"
  try {
    await setStub({ put: "ok", putDelay: "0" })
    await openSettings(page)
    await page.evaluate(installMotionRecorder)
    const button = saveButton(page, "Job criteria")
    await scrollTo(button, "middle")
    await button.click()
    await waitForToast(page, "Saved.")
    await page.waitForTimeout(300)
    await button.click()
    await page.waitForFunction(() => window.__toastRec.toasts.length >= 2 && window.__toastRec.toasts[0].reflow, null, { timeout: 15_000 })
    const older = (await motionRecord(page)).toasts[0]
    const reflow = older.reflow
    const f = []
    if (!reflow.found) f.push(`no running transform transition on the older toast in ${reflow.frame} frames`)
    expectLayers(f, reflow, { transform: 200, height: 150 }, "older toast")
    expectLayers(f, reflow.content, { opacity: 200 }, "older content")
    record(id, "Motion timing", `reflow ${caseName}`, f, `older: ${layersText(reflow)}; content: ${layersText(reflow.content)} (* running)`)
  } catch (error) {
    record(id, "Motion timing", `reflow ${caseName}`, [String(error.message).split("\n")[0]], "")
  } finally {
    await ctx.close()
  }
}

// ---------------------------------------------------------------- main

async function main() {
  const stubFile = stubPath()
  if (!existsSync(stubFile)) throw new Error(`stub not found: ${stubFile} (set TOAST_SWEEP_STUB)`)
  const [stubPort, webPort] = [await freePort(), await freePort()]
  stub = `http://127.0.0.1:${stubPort}`
  base = `http://127.0.0.1:${webPort}`
  await start(process.execPath, [stubFile], { STUB_PORT: String(stubPort) }, "stub on", "stub")
  await start(path.join(WEB_DIR, "node_modules/.bin/vite"), ["--port", String(webPort), "--strictPort", "--host", "127.0.0.1"], { API_PROXY_TARGET: stub }, "Local:", "vite")

  const pw = await loadPlaywright()
  console.log(`playwright-core ${pw.version} from ${pw.dir}${pw.override ? " (PLAYWRIGHT_CORE_PATH)" : ""}`)
  console.log(`stub ${stubFile}${process.env.TOAST_SWEEP_STUB ? " (TOAST_SWEEP_STUB)" : ""}`)
  let browser
  try {
    browser = await pw.chromium.launch({ headless: process.env.TOAST_SWEEP_HEADED !== "1" })
  } catch (error) {
    throw new Error(`${error.message.split("\n")[0]}\nIf Chromium is missing: pnpm --filter @eve/web exec playwright-core install chromium`)
  }
  console.log(`toast geometry sweep · stub :${stubPort} · vite :${webPort} · chromium ${browser.version()}`)
  try {
    let n = 0
    const id = (p) => `${p}${String(++n).padStart(2, "0")}`
    for (const size of ["375x812", "375x667"])
      for (const section of SECTIONS) for (const position of ["top", "middle", "bottom"]) await placementCase(browser, id("P"), size, section, position, "tap")
    await placementCase(browser, id("P"), "375x812", "Job criteria", "bottom", "Enter")
    await placementCase(browser, id("P"), "375x667", "Job criteria", "top", "Enter")
    n = 0
    for (const size of ["375x812", "375x667"]) for (const position of ["top", "middle", "bottom"]) await savedThenErrorCase(browser, id("E"), size, position)
    n = 0
    await noTriggerCase(browser, id("N"))
    n = 0
    let m = 0
    const mid = () => `M${String(++m).padStart(2, "0")}`
    await swipeCase(browser, id("S"), "bottom", mid)
    await swipeCase(browser, id("S"), "top", mid)
    n = 0
    for (const width of [768, 1280]) for (const half of ["upper", "lower"]) await desktopCase(browser, id("D"), width, half)
    n = 0
    for (const width of [375, 1280]) await screenReaderCase(browser, id("A"), width)
    n = 0
    await reducedMotionCase(browser, id("R"), 375, "top")
    await reducedMotionCase(browser, id("R"), 375, "bottom")
    await reducedMotionCase(browser, id("R"), 1280, "bottom")
    await motionEnterRestExitCase(browser, mid, 375, "top")
    await motionEnterRestExitCase(browser, mid, 375, "bottom")
    await motionEnterRestExitCase(browser, mid, 1280, "bottom")
    await motionOrphanCase(browser, mid())
    await motionReflowCase(browser, mid())
  } finally {
    await browser.close()
  }
}

/** Groups in the order the spec lists them; swipe M rows are measured during the S cases. */
const GROUP_ORDER = ["P", "E", "N", "S", "D", "A", "R", "M"]

function printTable() {
  const sorted = [...results].sort((a, b) => GROUP_ORDER.indexOf(a.id[0]) - GROUP_ORDER.indexOf(b.id[0]) || a.id.localeCompare(b.id))
  const rows = sorted.map((r) => [r.id, r.pass ? "PASS" : "FAIL", r.scenario, r.caseName, r.detail, r.info])
  const head = ["id", "result", "scenario", "case", "measured / failure", "info (other controls, not a failure)"]
  const widths = head.map((h, i) => Math.min(70, Math.max(h.length, ...rows.map((r) => String(r[i]).length))))
  const line = (cells) => cells.map((c, i) => String(c).slice(0, widths[i]).padEnd(widths[i])).join(" | ").trimEnd()
  console.log(line(head))
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"))
  for (const r of rows) console.log(line(r))
  const failed = results.filter((r) => !r.pass).length
  console.log(`\n${results.length - failed} passed, ${failed} failed, ${results.length} cases`)
  return failed
}

let exitCode = 0
try {
  await main()
} catch (error) {
  console.error(`sweep aborted: ${error.message}`)
  exitCode = 2
} finally {
  stopAll()
}
if (results.length) exitCode = printTable() > 0 ? 1 : exitCode
process.exit(exitCode)
