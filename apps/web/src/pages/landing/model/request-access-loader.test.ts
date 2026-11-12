import { describe, expect, it, vi } from "vitest"

import { createChunkLoader } from "./request-access-loader"

// F-QA-E3-02, request-access.feature:249. Browsers keep a failed module fetch in
// the module map, so importing the same specifier again rejects without a new
// request. The doubles model that: the static import keeps rejecting.
const CHUNK = `${window.location.origin}/assets/request-access-abc123.js`
const failed = () => new TypeError(`Failed to fetch dynamically imported module: ${CHUNK}`)
const formModule = { RequestAccessForm: () => null }

describe("createChunkLoader", () => {
  it("retries a failed chunk under a fresh URL, so the browser fetches it again", async () => {
    const importStatic = vi.fn(() => Promise.reject(failed()))
    const importUrl = vi.fn(() => Promise.resolve(formModule))
    const load = createChunkLoader(importStatic, importUrl)

    await expect(load()).rejects.toThrow(TypeError)
    await expect(load()).resolves.toBe(formModule)

    expect(importStatic).toHaveBeenCalledTimes(1)
    expect(importUrl).toHaveBeenCalledWith(`${CHUNK}?retry=1`)
  })

  it("uses a new URL on every retry", async () => {
    const importUrl = vi.fn().mockRejectedValueOnce(failed()).mockResolvedValueOnce(formModule)
    const load = createChunkLoader(() => Promise.reject(failed()), importUrl)

    await expect(load()).rejects.toThrow()
    await expect(load()).rejects.toThrow()
    await expect(load()).resolves.toBe(formModule)
    expect(importUrl.mock.calls.map(([url]) => url)).toEqual([`${CHUNK}?retry=1`, `${CHUNK}?retry=2`])
  })

  it("shares one request between hover, focus and press, and keeps a success", async () => {
    const importStatic = vi.fn(() => Promise.resolve(formModule))
    const load = createChunkLoader(importStatic, vi.fn())
    await Promise.all([load(), load(), load()])
    await load()
    expect(importStatic).toHaveBeenCalledTimes(1)
  })

  it("never imports a URL from another origin", async () => {
    const importStatic = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module: https://evil.example/x.js")).mockResolvedValueOnce(formModule)
    const importUrl = vi.fn()
    const load = createChunkLoader(importStatic, importUrl)
    await expect(load()).rejects.toThrow()
    await expect(load()).resolves.toBe(formModule)
    expect(importUrl).not.toHaveBeenCalled()
  })

  it("falls back to the static import when the error names no chunk URL", async () => {
    const importStatic = vi.fn().mockRejectedValueOnce(new TypeError("Importing a module script failed.")).mockResolvedValueOnce(formModule)
    const importUrl = vi.fn()
    const load = createChunkLoader(importStatic, importUrl)
    await expect(load()).rejects.toThrow()
    await expect(load()).resolves.toBe(formModule)
    expect(importUrl).not.toHaveBeenCalled()
  })
})
