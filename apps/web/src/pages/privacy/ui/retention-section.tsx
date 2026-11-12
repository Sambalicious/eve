import { CalendarClock, Hand, Pause, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router-dom"

import { fillCopy, linkNameSuffix, plural, retentionCopy as c, type RetentionFacts } from "@/entities/retention"
import { hiringCopy } from "@/entities/stack-post"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { Section } from "@/shared/ui/section"
import { RetentionFactsSkeleton } from "@/components/page-skeletons"

const linkClass =
  "inline-flex items-center text-sm font-medium underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground pointer-coarse:min-h-11"

/**
 * "Retention" (`#retention`, design-spec-12-month-expiry B1): the rule
 * C-RET-1 as the section description, then the facts from `GET /v1/retention`:
 * the failed-run alert C-RET-9, the paused note C-RET-10, the grace note
 * C-RET-22 while `graceEndsOn` is set (any due count, DR9-02), "Due in the
 * next 30 days" (C-RET-2 to -5; during the launch grace its date is the grace end,
 * D-E5), "Waiting for your decision" only when above zero (C-RET-11, -6, -7),
 * and the minimal records helper C-RET-8. The rule shows while the facts load
 * or fail. No setting turns expiry off and no action starts a run (D-E8).
 */
export function RetentionSection({
  facts,
  isError,
  onRetry,
  paused,
}: {
  facts: RetentionFacts | undefined
  isError: boolean
  onRetry: () => void
  paused: boolean
}) {
  return (
    <Section
      id="retention"
      title={c["privacy.retention.title"]}
      description={
        <>
          <p className="text-pretty">{c["privacy.retention.rule"]}</p>
          {/* EPIC-0007 C-DATA-1 (Phase 3): the posts retention sentence, both lists. */}
          <p className="mt-1 text-pretty">{hiringCopy.dataRetentionPosts}</p>
        </>
      }
      layout="split"
      headingProps={{ id: "retention-heading", tabIndex: -1 }}
    >
      {isError ? (
        <LoadErrorAlert onRetry={onRetry} />
      ) : !facts ? (
        <RetentionFactsSkeleton />
      ) : (
        <div className="flex flex-col gap-3">
          {facts.lastFailureOn && (
            <Alert role="status" className="border-warning/40 bg-card *:[svg]:text-warning-text">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle className="font-normal text-pretty">
                {fillCopy(c["privacy.retention.runFailed"], { date: formatWatDate(facts.lastFailureOn) })}
              </AlertTitle>
            </Alert>
          )}
          {paused && (
            <p className="flex items-start gap-2 text-sm text-pretty">
              <Pause aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-text" />
              {c["privacy.retention.paused"]}
            </p>
          )}
          {facts.graceEndsOn && <GraceNote on={facts.graceEndsOn} />}
          <dl className="flex flex-col divide-y">
            <Fact label={c["privacy.retention.due.label"]}>
              <span className="flex items-start gap-2">
                <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <DueValue due={facts.dueNext30Days} />
              </span>
            </Fact>
            {facts.waitingForDecisionCount > 0 && (
              <Fact label={c["privacy.retention.waiting.label"]}>
                <span className="flex items-start gap-2 text-warning-text">
                  <Hand aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span className="text-pretty">
                    {fillCopy(plural(facts.waitingForDecisionCount, c["privacy.retention.waiting.value"]), { n: facts.waitingForDecisionCount })}
                  </span>
                </span>
                <LabelInNameLink
                  to="/applications?retention=waiting"
                  visible={plural(facts.waitingForDecisionCount, c["privacy.retention.waiting.link"])}
                  name={fillCopy(plural(facts.waitingForDecisionCount, c["privacy.retention.waiting.linkLabel"]), { n: facts.waitingForDecisionCount })}
                />
              </Fact>
            )}
          </dl>
          <p className="text-[0.8125rem] text-pretty text-muted-foreground">
            {c["privacy.retention.minimalHelp"].text}{" "}
            <Link
              to="#records"
              className="font-medium whitespace-nowrap text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              {c["privacy.retention.minimalHelp"].link}
            </Link>
          </p>
        </div>
      )}
    </Section>
  )
}

/**
 * Visually hidden, kept inline in one span with the visible text, so the
 * computed name equals C-RET-A1/A2 exactly. Tailwind's `sr-only` (absolute)
 * and any inline-block make Chromium join the parts with a space ("Show these
 * Applications , 3 due…"); zero font size plus a clip does not. Checked in
 * Chromium's accessibility tree (RUN_ROOT/harness/axtree.cjs).
 */
const inlineSrOnly = "text-[0px] [clip-path:inset(50%)]"

/**
 * C-RET-5 / C-RET-7 with names C-RET-A1 / C-RET-A2 (deck r3, CR9-02): the
 * visible text, then the rest of the name sr-only. No `aria-label`, so the
 * accessible name starts with the words on screen (WCAG 2.5.3 Label in Name).
 */
function LabelInNameLink({ to, visible, name }: { to: string; visible: string; name: string }) {
  return (
    <Link to={to} className={linkClass}>
      <span>
        {visible}
        <span data-name-suffix className={inlineSrOnly}>{linkNameSuffix(visible, name)}</span>
      </span>
    </Link>
  )
}

/** C-RET-22: a neutral note line, the date in `<time>`. No link or action: the grace has no control (D-E5). */
function GraceNote({ on }: { on: string }) {
  const [before, after] = c["privacy.retention.graceStarts"].split("{date}")
  return (
    <p className="flex items-start gap-2 text-sm text-pretty">
      <CalendarClock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span>
        {before}
        <time dateTime={on}>{formatWatDate(on)}</time>
        {after}
      </span>
    </p>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 py-3 first:pt-0 last:pb-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-col items-start gap-1 text-sm tabular-nums">{children}</dd>
    </div>
  )
}

/** C-RET-3 with its date, the no-date fallback (never "on null"), or C-RET-4 at zero; the link C-RET-5 only above zero. */
function DueValue({ due }: { due: RetentionFacts["dueNext30Days"] }) {
  if (due.count === 0) return <span className="text-pretty">{c["privacy.retention.due.none"]}</span>
  const forms = c["privacy.retention.due.value"]
  const value = due.earliestOn
    ? fillCopy(plural(due.count, forms), { n: due.count, date: formatWatDate(due.earliestOn) })
    : fillCopy(due.count === 1 ? forms.oneNoDate : forms.otherNoDate, { n: due.count })
  return (
    <span className="flex flex-col items-start gap-1">
      <span className="text-pretty">{value}</span>
      <LabelInNameLink
        to="/applications?retention=due"
        visible={plural(due.count, c["privacy.retention.due.link"])}
        name={fillCopy(plural(due.count, c["privacy.retention.due.linkLabel"]), { n: due.count })}
      />
    </span>
  )
}
