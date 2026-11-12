import { useId, useState } from "react"
import { Lock, ShieldCheck, ShieldQuestionMark } from "lucide-react"

import {
  jobSourceCopy,
  type RemoteBoard,
  type RemoteBoardKey,
} from "@/entities/job-source"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { HelpPopover, HelpPopoverNote } from "@/shared/ui/help-popover"
import { Section } from "@/shared/ui/section"
import { Switch } from "@/shared/ui/switch"
import { useSetRemoteBoardEnabled } from "../model/use-manage-remote-board"
import { MarkVerifiedDialog } from "./mark-verified-dialog"

/**
 * Remote-job boards in the fixed order (Himalayas, Remote OK, Remotive, We
 * Work Remotely): name, type, verification (C-SRC-2 / C-SRC-4), Enabled
 * switch and "Mark verified". The switch of an unverified board uses
 * aria-disabled and shows C-SRC-3 on activation. A board the Candidate needs
 * permission for (Remotive) shows its reason and no switch. The section
 * description is C-EH-SRC-HELP plus one (i) for the section (EPIC-0009).
 *
 * Not built: "Add Job Source" and "Edit". The contract (v1.4.0) has no
 * endpoint to add a source; the list is fixed (frontend report).
 */
export function RemoteBoardsTable({
  boards,
}: {
  boards: readonly RemoteBoard[]
}) {
  const id = useId()
  const [refused, setRefused] = useState<RemoteBoardKey | null>(null)
  const [verifying, setVerifying] = useState<RemoteBoard | null>(null)
  const { setEnabled, pendingKey } = useSetRemoteBoardEnabled({
    onRefused: setRefused,
  })

  const toggle = (board: RemoteBoard, next: boolean) => {
    setRefused(null)
    if (next && !board.verification) return setRefused(board.key)
    setEnabled({ key: board.key, enabled: next })
  }

  return (
    <Section
      title={jobSourceCopy.remoteBoardsHeading}
      headingProps={{ id: `${id}-heading` }}
      description={<RemoteBoardsHelp />}
    >
      <ul className="flex flex-col divide-y">
        {boards.map((board) => (
          <li
            key={board.key}
            className="flex flex-col gap-2 py-4"
            aria-label={board.name}
          >
            <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
              <div className="flex min-w-[min(100%,18rem)] flex-1 flex-col gap-1">
                <span className="text-sm font-medium">{board.name}</span>
                <span className="text-xs text-muted-foreground">
                  {jobSourceCopy.remoteBoardType}
                </span>
                <Verification board={board} />
              </div>
              {board.unavailableReason === null && (
                <div className="flex shrink-0 items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setVerifying(board)}
                  >
                    {jobSourceCopy.markVerified}
                    <span className="sr-only">, {board.name}</span>
                  </Button>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={board.enabled}
                      aria-disabled={!board.verification || undefined}
                      disabled={pendingKey === board.key}
                      aria-describedby={
                        refused === board.key
                          ? `${id}-${board.key}-refused`
                          : undefined
                      }
                      onCheckedChange={(next) => toggle(board, next)}
                    />
                    <span>
                      Enabled<span className="sr-only">, {board.name}</span>
                    </span>
                  </label>
                </div>
              )}
            </div>
            {board.unavailableReason !== null && (
              <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                {board.unavailableReason}
              </p>
            )}
            {refused === board.key && (
              <p
                id={`${id}-${board.key}-refused`}
                role="alert"
                className="text-sm text-destructive-text"
              >
                {jobSourceCopy.enableRefused}{" "}
                <button
                  type="button"
                  className="underline underline-offset-4"
                  onClick={() => setVerifying(board)}
                >
                  {jobSourceCopy.markVerified}
                </button>
              </p>
            )}
          </li>
        ))}
      </ul>
      <MarkVerifiedDialog
        board={verifying}
        onClose={() => setVerifying(null)}
      />
    </Section>
  )
}

/** C-EH-SRC-HELP and the section's one (i) popover (C-EH-SRC-WHY-*). */
function RemoteBoardsHelp() {
  const why = jobSourceCopy.remoteBoardsWhy
  return (
    <div className="flex items-start gap-1">
      <p className="min-w-0 flex-1 text-pretty">{jobSourceCopy.remoteBoardsHelp}</p>
      <HelpPopover triggerLabel={why.triggerSr} title={why.title}>
        <p>{why.p1}</p>
        <p>{why.p2}</p>
        <HelpPopoverNote>{why.note}</HelpPopoverNote>
      </HelpPopover>
    </div>
  )
}

function Verification({ board }: { board: RemoteBoard }) {
  if (!board.verification) {
    return (
      <Badge variant="outline">
        <ShieldQuestionMark aria-hidden="true" />
        {jobSourceCopy.notVerified}
      </Badge>
    )
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <Badge variant="success">
        <ShieldCheck aria-hidden="true" />
        Verified
      </Badge>
      <span className="max-w-[72ch] text-sm [overflow-wrap:anywhere]">
        {jobSourceCopy.verified(
          board.verification.on,
          board.verification.basis
        )}
      </span>
    </div>
  )
}
