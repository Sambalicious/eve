import { type AnswerSources, type FormField, type Outcome, answerFor, classifyWorkQuestion, labelTampered } from "../answer-assignment.js"
import { OWNER_WORK_CONTEXT } from "../work-context.js"
import type { WorkLabel } from "./work-labels.extract.js"

export const WORK_LABELS_FILE = "work-labels.json"
export const WORK_SNAPSHOT_FILE = "work-question-regression.snap.json"

/** The commit the snapshot was captured on (golden-capture.feature :150; architecture r4 "A0 records the base commit in each snapshot header"). */
export const WORK_SNAPSHOT_BASE = "main b17e786 (pre-A1), proved on epic-0002/slice-a0-a1"

/**
 * The five `candidate_setting.work_authorization` texts the slice 5 classifier
 * read as "Nigeria only". EPIC-0002 B1: the classifier reads a WorkContext, and
 * every one of these texts meant `OWNER_WORK_CONTEXT`, so each column now runs
 * with it (r4: "After B it runs with OWNER_WORK_CONTEXT and must be byte-equal").
 * The keys stay, so the snapshot text is unchanged.
 */
export const OWNER_WORK_SETTINGS: readonly string[] = ["", "none outside Nigeria", "Nigeria", "Nigeria only", "only Nigeria"]

/** The owner's sources with the migrated setting and no work Approved Answers. */
const OWNER_SOURCES: AnswerSources = {
  fullName: "Ada Okafor",
  contactLines: ["Lagos, Nigeria", "ada@example.com", "+234 800 000 0000"],
  work: OWNER_WORK_CONTEXT,
  // r4: a role located outside Nigeria reproduces slice 5's fixed sponsorship "Yes".
  roleLocation: { kind: "countries", codes: ["US"] },
  answers: [{ group: "standard", topic: "notice_period", skill: null, question: null, value: "4 weeks" }],
  grossSalaryPolicy: { amount: "48000.00", currency: "USD", period: "year" },
  currentSalary: null,
}

const SELECT = { kind: "select" as const, options: ["Please select", "Yes", "No"] }

/** The spec's label-check fixtures (SEC-513): agreeing readings, a flagged source, a reading that names a second country. */
const TAMPER_FIXTURES: ReadonlyArray<readonly [name: string, check: (label: string) => FormField["labelCheck"]]> = [
  ["agreeing", (label) => ({ readings: [label, label], flags: [] })],
  ["hidden_node", (label) => ({ readings: [label, label], flags: ["hidden_node"] })],
  ["second_country", (label) => ({ readings: [label, `${label.replace(/[?*\s]+$/, "")} and Togo?`], flags: [] })],
]

/**
 * EPIC-0002 A0: the work-question golden over `work-labels.json`
 * (architecture r2, "A0 label regression set"). For each label: the
 * classifier under each accepted owner text, the `answerFor` outcome for a
 * schema-matched and a page-read field, and `labelTampered` for the spec's
 * flag fixtures. Returned as the exact file text.
 */
export function buildWorkSnapshot(labelsJson: string): string {
  const { labels } = JSON.parse(labelsJson) as { labels: WorkLabel[] }
  const rows = labels.map(({ label }) => ({
    label,
    classify: Object.fromEntries(OWNER_WORK_SETTINGS.map((setting) => [setting, classifyWorkQuestion(asAnswerForReadsIt(label), contextFor(setting))])),
    classifyRaw: Object.fromEntries(OWNER_WORK_SETTINGS.map((setting) => [setting, classifyWorkQuestion(label, contextFor(setting))])),
    schemaMatched: outcome(answerFor({ ref: "f1", label: "(page label ignored)", required: true, ...SELECT, fieldName: "question_1", schemaQuestion: { text: label, fieldName: "question_1" } }, OWNER_SOURCES)),
    pageRead: outcome(answerFor({ ref: "f1", label, required: true, ...SELECT }, OWNER_SOURCES)),
    labelTampered: Object.fromEntries(
      TAMPER_FIXTURES.map(([name, check]) => [name, labelTampered({ ref: "f1", label, required: true, ...SELECT, labelCheck: check(label) }, OWNER_SOURCES.work)])
    ),
  }))
  return `${JSON.stringify({ note: "EPIC-0002 A0 work-question golden. Regenerate only in its own commit with a reason.", capturedOn: WORK_SNAPSHOT_BASE, settings: OWNER_WORK_SETTINGS, rows }, null, 2)}\n`
}

/** Every accepted owner text is the Operator's context (B1). */
function contextFor(setting: string) {
  void setting
  return OWNER_WORK_CONTEXT
}

/** The label as `answerFor` passes it to the classifier (its private `normalise`, pinned here on purpose). */
function asAnswerForReadsIt(label: string): string {
  return label.normalize("NFKC").toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim()
}

function outcome(result: Outcome): unknown {
  if (result === "skip") return "skip"
  if ("leftover" in result) return { leftover: result.leftover }
  if ("reason" in result) return result
  return result.kind === "value"
    ? { kind: result.kind, value: result.value, source: result.source, work: result.work ?? false }
    : { kind: result.kind, document: result.document, source: result.source }
}
