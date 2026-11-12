import { closeSync, constants, futimesSync, mkdirSync, openSync } from "node:fs"
import { stat } from "node:fs/promises"
import { dirname } from "node:path"

/** Open for writing, create if missing, and fail with ELOOP if the path is a symlink (SEC-211). */
const OPEN_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW

/**
 * Touches a file on a timer while the event loop runs. A process without an HTTP
 * port (the worker) is healthy when the file's mtime is recent: a blocked or dead
 * process stops touching it. Used by the compose healthcheck (SEC-201).
 *
 * The file is opened once with O_NOFOLLOW (a symlink planted at the path makes
 * start() throw instead of touching its target) and kept open; each beat updates
 * the mtime through that descriptor, so the path is never resolved again. The
 * directory is created owner-only (0700) and the file 0600 (SEC-211).
 */
export class Heartbeat {
  private timer: NodeJS.Timeout | undefined
  private descriptor: number | undefined

  constructor(
    private readonly file: string,
    private readonly intervalMs: number
  ) {}

  start(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    this.descriptor = openSync(this.file, OPEN_FLAGS, 0o600)
    this.beat()
    this.timer = setInterval(() => this.beat(), this.intervalMs)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
    if (this.descriptor !== undefined) closeSync(this.descriptor)
    this.descriptor = undefined
  }

  private beat(): void {
    if (this.descriptor === undefined) return
    const now = new Date()
    futimesSync(this.descriptor, now, now)
  }
}

/** True when `file` was touched within `maxAgeMs`. */
export async function isHeartbeatFresh(file: string, maxAgeMs: number): Promise<boolean> {
  try {
    return Date.now() - (await stat(file)).mtimeMs <= maxAgeMs
  } catch {
    return false
  }
}
