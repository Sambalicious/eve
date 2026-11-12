import type { Page, Route } from "@playwright/test"

/**
 * EPIC-0009 failure and latency injection for the help states that depend on a
 * first-party query (hiring-view-help.feature AC-9 loading and error rows,
 * job-sources-help.feature "loading or failed"). Same rule as QA-G-02 in
 * check-this-job.phase2 and QG-2 in stack-feeds-per-user.epic8: no canned
 * response is ever returned. `failRequests` aborts matching requests at the
 * network layer (fetch rejects); `holdRequests` keeps matching requests pending
 * and then sends them unchanged to the real api. Every other request passes.
 */

/** Aborts every matching request until `stop()`. Returns how many were aborted. */
export async function failRequests(page: Page, path: string, method = "GET"): Promise<{ stop: () => Promise<void>; aborted: () => number }> {
  let failing = true
  let aborted = 0
  const pattern = `**${path}`
  // eslint-disable-next-line no-restricted-properties -- network-layer abort only, never a canned response (QA-G-02)
  await page.route(pattern, async (route) => {
    if (!failing || route.request().method() !== method) return route.fallback()
    aborted += 1
    await route.abort("internetdisconnected")
  })
  return {
    stop: async () => {
      failing = false
      await page.unroute(pattern)
    },
    aborted: () => aborted,
  }
}

/** Aborts exactly one matching request, then lets the rest through. */
export async function failOnce(page: Page, path: string, method: string): Promise<{ aborted: () => number }> {
  let aborted = 0
  // eslint-disable-next-line no-restricted-properties -- single request-abort failure injection (QA-G-02)
  await page.route(`**${path}`, async (route) => {
    if (route.request().method() !== method || aborted > 0) return route.fallback()
    aborted += 1
    await route.abort("internetdisconnected")
  })
  return { aborted: () => aborted }
}

/** Keeps every matching request pending until `release()`, then sends each, unchanged, to the real api. */
export async function holdRequests(page: Page, path: string): Promise<{ release: () => Promise<void>; held: () => number }> {
  const pending: Route[] = []
  let holding = true
  const pattern = `**${path}`
  // eslint-disable-next-line no-restricted-properties -- latency injection only: the request still reaches the real api
  await page.route(pattern, async (route) => {
    if (!holding) return route.fallback()
    pending.push(route)
  })
  return {
    release: async () => {
      holding = false
      for (const route of pending.splice(0)) await route.fallback()
      await page.unroute(pattern)
    },
    held: () => pending.length,
  }
}
