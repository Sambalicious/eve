import { readFileSync } from "node:fs"

/** Kilobytes from the `VmHWM:` line (peak resident set) of a /proc/<pid>/status text, or undefined. */
export function parseVmHwmKb(status: string): number | undefined {
  const match = /^VmHWM:\s+(\d+) kB$/m.exec(status)
  return match ? Number(match[1]) : undefined
}

/**
 * Peak resident memory of this process in kilobytes. On Linux `getrusage` maxRSS is
 * inherited across fork and exec, so a child spawned by a large parent reports the
 * parent's size; `VmHWM` belongs to the new image alone. Falls back to maxRSS
 * (macOS has no inheritance) when /proc is absent or unreadable.
 */
export function readPeakRssKb(): number {
  if (process.platform === "linux") {
    try {
      const peak = parseVmHwmKb(readFileSync("/proc/self/status", "utf8"))
      if (peak !== undefined) return peak
    } catch {
      // fall through to maxRSS
    }
  }
  return process.resourceUsage().maxRSS
}
