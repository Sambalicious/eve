import { ArrowRight, CircleSlash, KanbanSquare } from "lucide-react"

import { AppShell } from "@/components/app-shell"
import { LEAD_STAGE_LABEL, type Lead, PIPELINE_COLUMNS, PIPELINE_COLUMN_LABEL, columnOf, type PipelineColumn } from "@/entities/lead"
import { useDocumentTitle } from "@/shared/lib/use-document-title"
import { Button } from "@/shared/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/shared/ui/empty"
import { LoadErrorAlert } from "@/shared/ui/load-error-alert"
import { NativeSelect } from "@/shared/ui/native-select"
import { SkeletonText } from "@/shared/ui/skeleton"
import { pipelineCopy } from "../model/pipeline-copy"
import { usePipeline } from "../model/use-pipeline"

const STAGES = ["saved", "applied", "interviewing", "offer", "rejected"] as const

/**
 * Pipeline (`/pipeline`, v1.29.0): the Candidate's own stages over the jobs they
 * hold. Four columns — Saved, Applied, Interviewing and one Closed column for
 * Offer and Rejected — because the point is working leads forward, not archiving
 * them. Nothing here sends or prepares anything: it records what the Candidate did.
 */
export function PipelinePage() {
  useDocumentTitle(pipelineCopy.title)
  const { query, move, remove, markApplied } = usePipeline()
  const leads = query.data

  return (
    <AppShell title={pipelineCopy.title} description={pipelineCopy.description}>
      <div className="flex w-full max-w-[1120px] flex-col gap-4 px-4 lg:px-6">
        {query.isError ? (
          <LoadErrorAlert title={pipelineCopy.loadError} retryLabel={pipelineCopy.retry} onRetry={() => void query.refetch()} />
        ) : !leads ? (
          <SkeletonText widths={["w-40", "w-full", "w-2/3"]} />
        ) : leads.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <KanbanSquare aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>{pipelineCopy.emptyBoard.title}</EmptyTitle>
              <EmptyDescription>{pipelineCopy.emptyBoard.text}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {PIPELINE_COLUMNS.map((column) => (
              <PipelineColumnView
                key={column}
                column={column}
                leads={leads.filter((lead) => columnOf(lead.stage) === column)}
                onMarkApplied={markApplied}
                onMove={(lead, stage) => move.mutate({ jobPostingId: lead.jobPostingId, stage })}
                onRemove={(lead) => remove.mutate(lead.jobPostingId)}
              />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  )
}

function PipelineColumnView({
  column,
  leads,
  onMarkApplied,
  onMove,
  onRemove,
}: {
  column: PipelineColumn
  leads: Lead[]
  onMarkApplied: (lead: Lead) => void
  onMove: (lead: Lead, stage: Lead["stage"]) => void
  onRemove: (lead: Lead) => void
}) {
  return (
    <section aria-label={PIPELINE_COLUMN_LABEL[column]} className="flex flex-col gap-3 rounded-lg border bg-card/40 p-3">
      <h2 className="flex items-center justify-between text-sm font-semibold">
        {PIPELINE_COLUMN_LABEL[column]}
        <span className="text-xs font-normal text-muted-foreground tabular-nums">{leads.length}</span>
      </h2>
      {leads.length === 0 ? (
        <p className="text-xs text-muted-foreground">{pipelineCopy.emptyColumn}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {leads.map((lead) => (
            <LeadCard key={lead.jobPostingId} lead={lead} column={column} onMarkApplied={onMarkApplied} onMove={onMove} onRemove={onRemove} />
          ))}
        </ul>
      )}
    </section>
  )
}

function LeadCard({
  lead,
  column,
  onMarkApplied,
  onMove,
  onRemove,
}: {
  lead: Lead
  column: PipelineColumn
  onMarkApplied: (lead: Lead) => void
  onMove: (lead: Lead, stage: Lead["stage"]) => void
  onRemove: (lead: Lead) => void
}) {
  const role = lead.roleTitle ?? "Job"
  return (
    <li className="flex flex-col gap-2 rounded-md border bg-background p-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium [overflow-wrap:anywhere]">{role}</span>
        <span className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{lead.company ?? ""}</span>
      </div>
      {column === "closed" && (
        <span className="text-xs text-muted-foreground">{LEAD_STAGE_LABEL[lead.stage]}</span>
      )}
      {lead.stage === "saved" && (
        <Button size="sm" variant="outline" onClick={() => onMarkApplied(lead)} aria-label={`${pipelineCopy.markApplied}: ${role}`}>
          <ArrowRight aria-hidden="true" />
          {pipelineCopy.markApplied}
        </Button>
      )}
      <div className="flex items-center gap-2">
        <NativeSelect
          aria-label={`${pipelineCopy.moveTo}: ${role}`}
          value={lead.stage}
          onChange={(event) => onMove(lead, event.target.value as Lead["stage"])}
          className="h-8 flex-1 text-xs"
        >
          {STAGES.map((stage) => (
            <option key={stage} value={stage}>
              {LEAD_STAGE_LABEL[stage]}
            </option>
          ))}
        </NativeSelect>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`${pipelineCopy.remove}: ${role}`}
          onClick={() => onRemove(lead)}
        >
          <CircleSlash aria-hidden="true" />
        </Button>
      </div>
    </li>
  )
}
