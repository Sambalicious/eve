import { useRef, useState } from "react"
import { ChevronDown, Info } from "lucide-react"
import { Link } from "react-router-dom"

import { boardReasonCopy, boardUiCopy, type Application, type BoardColumn } from "@/entities/application"
import { formatWatDate } from "@/shared/lib/format-wat"
import { useMediaQuery } from "@/shared/lib/use-media-query"
import { Alert, AlertTitle } from "@/shared/ui/alert"
import { Button } from "@/shared/ui/button"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/shared/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip"
import { MoveMenu } from "@/features/move-application"
import { COLUMN_PAGE, useBoard, type BoardCard, type BoardColumnModel } from "../model/use-board"

const c = boardUiCopy

const count = (n: number) => (n > 99 ? "99+" : String(n))

const AUTOMATIC_LINK: Record<string, { to: string; label: string }> = {
  blocked: { to: "/blocked", label: c.move.linkBlocked },
  uncertain: { to: "/uncertain", label: c.move.linkUncertain },
  sample: { to: "/activation", label: c.move.linkSample },
}

/** Advanced off (owner decision 2, COPY PROPOSALS): the link names no automation page. */
const PLAIN_LINK_LABEL = { blocked: "See what needs you", uncertain: "See what Eve is unsure about", sample: "Review applications" } as const

function automaticLink(app: Application, advanced: boolean): { to: string; label: string } | null {
  const kind = app.board?.submissionState === "blocked" ? "blocked" : app.board?.submissionState === "uncertain" ? "uncertain" : app.board?.sampleState === "awaiting_review" ? "sample" : null
  if (!kind) return null
  const link = AUTOMATIC_LINK[kind]
  return advanced ? link : { to: link.to, label: PLAIN_LINK_LABEL[kind] }
}

/**
 * The Applications board (R6): one word per card, five columns and, only when they hold a card (and Advanced is
 * on, or the safety rule applies), Sending and Needs you. Wide screens lay the columns side by side in a focusable
 * region. Below 1024px each column is a collapsible section, so reading order stays one-dimensional. Drag is not
 * built; every move goes through "Move to…".
 */
export function ApplicationBoard({ applications, advanced }: { applications: readonly Application[]; advanced: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  const board = useBoard(applications, advanced, root)
  const wide = useMediaQuery("(min-width: 1024px)")
  // First paint: Draft and the first column that holds a card are open.
  const firstFilled = board.columns.find((column) => column.column !== "draft" && column.cards.length > 0)?.column
  const [opened, setOpened] = useState<Partial<Record<BoardColumn, boolean>>>({})
  const isOpen = (column: BoardColumn) => opened[column] ?? (column === "draft" || column === "needsYou" || column === firstFilled)
  return (
    <div ref={root} className="flex flex-col gap-3">
      {board.error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle className="font-normal">{board.error}</AlertTitle>
        </Alert>
      )}
      <p role="status" className="sr-only">
        {board.announcement}
      </p>
      <div
        role="region"
        aria-label={c.boardAria}
        tabIndex={wide ? 0 : undefined}
        className={wide ? "grid gap-4 overflow-x-auto pb-2" : "flex flex-col gap-3"}
        style={wide ? { gridTemplateColumns: `repeat(${board.columns.length}, minmax(220px, 1fr))` } : undefined}
      >
        {board.columns.map((column) => (
          <Column
            key={column.column}
            model={column}
            wide={wide}
            open={wide || isOpen(column.column)}
            onOpenChange={(open) => setOpened((current) => ({ ...current, [column.column]: open }))}
            word={board.columnWord(column.column)}
            pendingId={board.pendingId}
            advanced={advanced}
            onPick={board.pick}
          />
        ))}
      </div>
      <ConfirmDialog
        open={board.confirming !== null}
        onOpenChange={(open) => !open && board.cancelConfirm()}
        title={c.confirmApplied.title}
        body={c.confirmApplied.body}
        confirmLabel={c.confirmApplied.confirm}
        pendingLabel={c.confirmApplied.pending}
        isPending={board.pendingId !== null}
        onConfirm={() => void board.confirmApplied()}
      />
    </div>
  )
}

function Column({
  model,
  wide,
  open,
  onOpenChange,
  word,
  pendingId,
  advanced,
  onPick,
}: {
  advanced: boolean
  model: BoardColumnModel
  wide: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  word: string
  pendingId: string | null
  onPick: (card: BoardCard, option: BoardCard["options"][number]) => void
}) {
  const [shown, setShown] = useState(COLUMN_PAGE)
  const cards = model.cards.slice(0, shown)
  const label = c.columnAria(word, model.cards.length)
  const body = (
    <>
      {model.cards.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">{c.columnEmpty[model.column]}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {cards.map((card) => (
            <li key={card.app.id}>
              <Card card={card} advanced={advanced} pending={pendingId === card.app.id} onPick={onPick} />
            </li>
          ))}
        </ul>
      )}
      {model.cards.length > shown && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShown((n) => n + COLUMN_PAGE)}>
          {c.showMore}
        </Button>
      )}
    </>
  )
  const heading = (
    <span className="flex items-baseline gap-2 text-[0.8125rem] font-medium">
      <h3 className="text-[0.8125rem] font-medium" tabIndex={-1} data-column-heading={model.column}>
        {word}
      </h3>
      <span className="text-muted-foreground tabular-nums" aria-hidden="true">
        {count(model.cards.length)}
      </span>
    </span>
  )
  const help = <ColumnHelp word={word} column={model.column} />
  if (wide) {
    return (
      <section aria-label={label} className="flex min-w-0 flex-col gap-2">
        <span className="flex items-center gap-1">
          {heading}
          {help}
        </span>
        {body}
      </section>
    )
  }
  return (
    <section aria-label={label}>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex items-center gap-3 border-b py-2">
          <CollapsibleTrigger className="flex flex-1 cursor-pointer items-center justify-between gap-3 text-left pointer-coarse:min-h-11">
            {heading}
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 transition-transform data-[panel-open]:rotate-180" />
          </CollapsibleTrigger>
          {help}
        </div>
        <CollapsibleContent className="pt-3">{body}</CollapsibleContent>
      </Collapsible>
    </section>
  )
}

/** The heading's help button: its tooltip says what the column word means. */
function ColumnHelp({ word, column }: { word: string; column: BoardColumn }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        <Info aria-hidden="true" className="size-3.5" />
        <span className="sr-only">{c.columnHelpAria(word)}</span>
      </TooltipTrigger>
      <TooltipContent>{c.columnHelp[column]}</TooltipContent>
    </Tooltip>
  )
}

function Card({
  card,
  advanced,
  pending,
  onPick,
}: {
  advanced: boolean
  card: BoardCard
  pending: boolean
  onPick: (card: BoardCard, option: BoardCard["options"][number]) => void
}) {
  const { app, placement } = card
  const title = app.roleTitle ?? app.company ?? app.requisitionId
  const link = placement.automatic ? automaticLink(app, advanced) : null
  const detail =
    placement.reason ?? (placement.employerAsked ? null : formatWatDate(app.updatedAt))
  return (
    <div
      data-card-id={app.id}
      className="flex flex-col gap-1 rounded-xl p-3 ring-1 ring-foreground/10 aria-busy:opacity-60"
      aria-busy={pending || undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <Link
          to={`/applications/${app.id}`}
          title={title}
          className="line-clamp-2 min-w-0 text-sm font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline"
        >
          {title}
        </Link>
        <MoveMenu title={title} options={card.options} busy={pending} onPick={(option) => onPick(card, option)} />
      </div>
      {app.company && app.roleTitle && <p className="truncate text-[0.8125rem] text-muted-foreground">{app.company}</p>}
      {placement.automatic ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          {placement.reason}
          {link && (
            <>
              {" "}
              <Link to={link.to} className="text-foreground underline underline-offset-4">
                {link.label}
              </Link>
            </>
          )}
        </p>
      ) : (
        detail && (
          <p className="truncate text-[0.8125rem] text-muted-foreground" title={detail}>
            {detail}
          </p>
        )
      )}
      {placement.employerAsked && <p className="truncate text-[0.8125rem] text-muted-foreground">{boardReasonCopy.employerAsked}</p>}
    </div>
  )
}
