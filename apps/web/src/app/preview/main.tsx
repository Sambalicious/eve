/**
 * Designer preview entry (dev only). Starts an MSW service worker with the
 * contract fakes for the chosen scenario, then boots the real app. Loaded only
 * by `preview.html`, which the dev server serves for app paths when
 * `EVE_PREVIEW=1`; `vite build` never includes it.
 */
import { http, HttpResponse } from "msw"
import { setupWorker } from "msw/browser"

// Direct module imports: the testing index also loads the msw/node server, which can't run in a browser.
// contract-handlers comes first, as in the testing index: it imports the other fakes, which only call it lazily.
import { apiErrorResponse, logoutEndpoint, signedInSession } from "@/shared/testing/contract-handlers"
import { createCareerSetupApi } from "@/shared/testing/career-setup-api"
import { createControlsApi } from "@/shared/testing/controls-api"
import { createDiscoveryApi } from "@/shared/testing/discovery-api"
import { createDocumentsApi, linkOutcomes } from "@/shared/testing/documents-api"
import { linkFakes } from "@/shared/testing/apply-anyway-fake"
import { createHiringSearchInputsApi, OPERATOR_PREFERENCES } from "@/shared/testing/hiring-search-inputs-api"
import { createStackPostsApi } from "@/shared/testing/stack-posts-api"
import { freshNotificationHandlers, notificationFailure, notificationStatusHandler } from "@/shared/testing/notifications-api"
import { createSubmissionApi } from "@/shared/testing/submission-api"
import { createMeApi, operatorMe } from "@/shared/testing/me-api"
import { createPreferencesApi } from "@/shared/testing/preferences-api"
import { previewCareer, scenarios, type ScenarioName } from "./scenarios"

const SCENARIO_KEY = "eve-preview-scenario"

/** Apply-anyway preview: one forced answer for the next create or remove, then the contract fake answers. */
function onceHandlers(scenario: (typeof scenarios)[ScenarioName]) {
  const handlers = []
  if ("nextCreate" in scenario && scenario.nextCreate) {
    const next = scenario.nextCreate
    handlers.push(http.post("/v1/applications", () => (next === "network" ? HttpResponse.error() : apiErrorResponse(next)), { once: true }))
  }
  if ("nextRemove" in scenario && scenario.nextRemove) {
    const next = scenario.nextRemove
    handlers.push(http.post("/v1/applications/:id/remove-from-queue", () => (next === "network" ? HttpResponse.error() : apiErrorResponse("application_state_conflict")), { once: true }))
  }
  return handlers
}

function chosenScenario(): ScenarioName {
  const fromUrl = new URLSearchParams(window.location.search).get("scenario")
  const name = fromUrl ?? sessionStorage.getItem(SCENARIO_KEY) ?? "board"
  const valid = (name in scenarios ? name : "board") as ScenarioName
  sessionStorage.setItem(SCENARIO_KEY, valid)
  return valid
}

async function start() {
  const name = chosenScenario()
  const scenario = scenarios[name]
  const discovery = createDiscoveryApi(scenario.discovery)
  const seeded = "applications" in scenario ? scenario.applications : []
  const documents = createDocumentsApi({ applications: seeded.map((e) => ({ ...e.app })) })
  linkFakes(discovery, documents)
  const controls = createControlsApi()
  controls.state.outcomes.push(
    ...("outcomes" in scenario ? scenario.outcomes : []).map((o, i) => ({
      id: `e1300000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
      applicationId: o.applicationId,
      type: o.type,
      source: "candidate" as const,
      excerpt: null,
      createdAt: "2026-11-05T10:00:00.000Z",
      updatedAt: "2026-11-05T10:00:00.000Z",
    }))
  )
  linkOutcomes(documents, controls)
  const submissions = Object.fromEntries(seeded.map((e) => [e.app.id, { ...e.submission }]))
  // One-shot scenario handlers go first: MSW uses the first matching handler, and documents.handlers also serves POST /v1/applications.
  const me = createMeApi("me" in scenario && scenario.me ? scenario.me : operatorMe())
  if ("meFailWrites" in scenario && scenario.meFailWrites) me.state.failWrites = true
  const career = createCareerSetupApi({ ...previewCareer, ...("career" in scenario ? scenario.career : {}) })
  if ("finishDraftingAfterMs" in scenario && scenario.finishDraftingAfterMs) {
    const after = scenario.finishDraftingAfterMs
    let seen = false
    window.setInterval(() => {
      if (career.state.drafting?.status === "drafting" && !seen) {
        seen = true
        window.setTimeout(() => {
          career.finishDrafting()
          seen = false
        }, after)
      }
    }, 500)
  }
  const emailFailure = "emailFailure" in scenario ? scenario.emailFailure : undefined
  const worker = setupWorker(
    ...onceHandlers(scenario),
    ...("outcomeWritesFail" in scenario && scenario.outcomeWritesFail
      ? [http.post("/v1/applications/:id/outcomes", () => apiErrorResponse("internal_error"))]
      : []),
    ...(emailFailure
      ? [notificationStatusHandler({ senderConfigured: true, latestFailure: notificationFailure({ emailType: emailFailure }) })]
      : []),
    signedInSession,
    logoutEndpoint,
    ...career.handlers,
    ...controls.handlers,
    ...me.handlers,
    ...discovery.handlers,
    ...documents.handlers,
    ...createSubmissionApi(documents, { submissions }).handlers,
    ...createStackPostsApi("stack" in scenario ? scenario.stack : {}).handlers,
    ...createHiringSearchInputsApi({ preferences: OPERATOR_PREFERENCES }).handlers,
    ...freshNotificationHandlers,
    ...createPreferencesApi({ now: () => new Date(), ...("preferences" in scenario ? scenario.preferences : {}) }).handlers
  )
  await worker.start({ quiet: true })
  // Drop the scenario parameter so the app sees its own URL; the choice stays in sessionStorage for reloads.
  const url = new URL(window.location.href)
  url.searchParams.delete("scenario")
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  console.info(`[preview] scenario "${name}": ${scenario.description}`)
  if (url.pathname === "/preview/step-3") return (await import("./step3-mount")).mountStep3()
  await import("@/app/main")
}

void start()
