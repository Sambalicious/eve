import "@testing-library/jest-dom/vitest"
import { File as NodeFile } from "node:buffer"
import { cleanup, configure } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, vi } from "vitest"

import { toast } from "@/shared/ui/toast"
import { server } from "./server"

// Pages are lazy routes. The first render in a file transforms the page module,
// which can take over Testing Library's 1 s default when the machine is busy
// (turbo runs the api's container tests at the same time).
configure({ asyncUtilTimeout: 5000 })

beforeAll(async () => {
  installMatchMedia()
  installPointerCapture()
  installResizeObserver()
  server.listen({ onUnhandledFrame: "error" })
  // After listen: MSW wraps fetch, and the bridge must run before MSW reads the body.
  await installMultipartFetchBridge()
})
afterEach(() => {
  // Toasts live in a module-level store (Sonner); none may leak into the next test.
  toast.dismiss()
  cleanup()
  // A test that faked timers to skip a delay gets real ones back, even if it failed.
  vi.useRealTimers()
  server.resetHandlers()
  localStorage.clear()
})
afterAll(() => server.close())

/** jsdom has no ResizeObserver or scrollIntoView; cmdk (the country picker's list) calls both. */
function installResizeObserver() {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Element.prototype.scrollIntoView ??= () => undefined
}

/** jsdom has no pointer capture; Sonner calls it when a toast is pressed (swipe). */
function installPointerCapture() {
  Element.prototype.setPointerCapture ??= () => undefined
  Element.prototype.releasePointerCapture ??= () => undefined
  Element.prototype.hasPointerCapture ??= () => false
}

/** jsdom has no matchMedia. The shell reads it for the theme and mobile layout. */
function installMatchMedia() {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })
}

/**
 * Vitest 5's jsdom fetch bridge sends a jsdom File inside FormData with a
 * wrong content-length, so the request never reaches MSW. Browsers have no
 * such problem. This rebuilds a jsdom multipart body with Node's FormData and
 * File, same field names, file names, types and bytes, before fetch sends it.
 * Nothing else about the request changes and MSW still intercepts it.
 */
async function installMultipartFetchBridge() {
  // Node's own FormData, reached through a Response because jsdom replaces the global.
  const NodeFormData = (await new Response(new URLSearchParams()).formData()).constructor as typeof FormData
  const jsdomFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (!(init?.body instanceof FormData)) return jsdomFetch(input, init)
    const body = new NodeFormData()
    for (const [name, value] of init.body.entries()) {
      if (typeof value === "string") body.append(name, value)
      else body.append(name, new NodeFile([await value.arrayBuffer()], value.name, { type: value.type }))
    }
    return jsdomFetch(input, { ...init, body })
  }
}
