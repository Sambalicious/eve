import net from "node:net"

/**
 * FU-5: the port the Vite dev server listens on and the browser's baseURL use.
 * Both playwright.config.ts and global setup read it from here, so setting
 * E2E_WEB_PORT moves the whole run.
 */
export const DEFAULT_WEB_PORT = 5199
export const WEB_PORT_ENV = "E2E_WEB_PORT"

export function resolveWebPort(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env[WEB_PORT_ENV]
  if (raw === undefined || raw === "") return DEFAULT_WEB_PORT
  const port = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${WEB_PORT_ENV} must be a TCP port between 1 and 65535 (got "${raw}")`)
  }
  return port
}

/**
 * Throws when anything already accepts connections on the port at 127.0.0.1 or
 * ::1. `localhost` can resolve to either, so a server on one of them (another
 * worktree's Vite, say) would otherwise answer the readiness probe and the tests.
 */
export async function assertPortFree(port: number): Promise<void> {
  const taken: string[] = []
  for (const host of ["127.0.0.1", "::1"]) if (await accepts(host, port)) taken.push(host)
  if (taken.length > 0) {
    throw new Error(
      `Port ${port} is already in use on ${taken.join(" and ")}. Stop that process (lsof -nP -iTCP:${port} -sTCP:LISTEN) ` +
        `or set ${WEB_PORT_ENV} to a free port. The E2E run will not attach to a server it did not start.`,
    )
  }
}

function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(1_000, () => done(false))
    socket.once("connect", () => done(true))
    socket.once("error", () => done(false))
  })
}
