import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { WORKER_HEARTBEAT_FILE } from "../worker/worker-heartbeat.js"
import { Heartbeat, isHeartbeatFresh } from "./heartbeat.js"

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ja-heartbeat-"))
  dirs.push(dir)
  return join(dir, "heartbeat")
}

// SEC-201 follow-up: the worker has no HTTP port; compose checks this file instead.
describe("Heartbeat", () => {
  it("writes the file at start and keeps its mtime fresh while the event loop runs", async () => {
    const file = await tempFile()
    const heartbeat = new Heartbeat(file, 50)
    heartbeat.start()
    try {
      const first = (await stat(file)).mtimeMs
      await new Promise((resolve) => setTimeout(resolve, 180))
      expect((await stat(file)).mtimeMs).toBeGreaterThan(first)
      expect(await isHeartbeatFresh(file, 1_000)).toBe(true)
    } finally {
      heartbeat.stop()
    }
  })

  it("is stale when the process stops beating (a blocked or dead worker)", async () => {
    const file = await tempFile()
    const heartbeat = new Heartbeat(file, 50)
    heartbeat.start()
    heartbeat.stop()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(await isHeartbeatFresh(file, 100)).toBe(false)
  })

  it("is not fresh when the file does not exist", async () => {
    expect(await isHeartbeatFresh(join(await mkdtemp(join(tmpdir(), "ja-hb-")), "missing"), 1_000)).toBe(false)
  })
})

// SEC-211: the heartbeat must not follow a planted symlink or live in a shared directory.
describe("Heartbeat file safety (SEC-211)", () => {
  it("refuses to write through a symlink planted at the heartbeat path", async () => {
    const { symlink, writeFile, readFile } = await import("node:fs/promises")
    const dir = await mkdtemp(join(tmpdir(), "ja-heartbeat-link-"))
    dirs.push(dir)
    const victim = join(dir, "victim")
    await writeFile(victim, "do not touch")
    const file = join(dir, "heartbeat")
    await symlink(victim, file)
    const heartbeat = new Heartbeat(file, 20)
    expect(() => heartbeat.start()).toThrow(/ELOOP|symbolic link/)
    heartbeat.stop()
    expect(await readFile(victim, "utf8")).toBe("do not touch")
  })

  it("creates its directory owner-only (0700) and the file 0600", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "ja-heartbeat-dir-")), "worker")
    dirs.push(dir)
    const file = join(dir, "heartbeat")
    const heartbeat = new Heartbeat(file, 20)
    heartbeat.start()
    heartbeat.stop()
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it("the worker's heartbeat lives in an app-owned directory, not directly in /tmp", () => {
    // Imported at the top: loading the Nest-based worker module inside the test body
    // took over 5 s under CPU contention (a test-budget timeout, not a defect).
    expect(dirname(WORKER_HEARTBEAT_FILE)).not.toBe("/tmp")
    expect(WORKER_HEARTBEAT_FILE.startsWith("/tmp/")).toBe(false)
  })
})
