import { useId, useState } from "react"
import { CircleCheck } from "lucide-react"

import { jobSourceCopy, type EmployerList } from "@/entities/job-source"
import { Badge } from "@/shared/ui/badge"
import { Button } from "@/shared/ui/button"
import { Section } from "@/shared/ui/section"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table"
import { useApproveEmployerList } from "../model/use-approve-employer-list"

/**
 * "Employer list" card (F1 step 7a): status C-SRC-6 or C-SRC-7, help C-SRC-5,
 * the companies (company, Application System, board URL as text) with
 * "{n} companies", and "Approve employer list" until approved. Approval is
 * one action for the whole list; there are no add, remove or edit controls.
 */
export function EmployerListCard({ list }: { list: EmployerList }) {
  const id = useId()
  const [confirming, setConfirming] = useState(false)
  const { approve, isApproving } = useApproveEmployerList({
    onApproved: () => setConfirming(false),
  })
  const n = list.companies.length
  return (
    <Section
      id="employer-list"
      title={jobSourceCopy.employerListHeading}
      headingProps={{ id: `${id}-heading` }}
      description={
        <span className="flex flex-col gap-1">
          {list.approvedAt ? (
            <span className="flex items-start gap-1.5 text-foreground">
              <CircleCheck
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-success-text"
              />
              {jobSourceCopy.approved(list.approvedAt, n)}
            </span>
          ) : (
            <span className="text-foreground">{jobSourceCopy.notApproved}</span>
          )}
          <span>{jobSourceCopy.employerListHelp}</span>
        </span>
      }
    >
      <div className="flex flex-col gap-2">
        <p className="text-[0.8125rem] text-muted-foreground tabular-nums">
          {jobSourceCopy.companyCount(n)}
        </p>
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Employer list, scrolls horizontally"
        >
          <Table scroll={false}>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead>Application System</TableHead>
                <TableHead>Board URL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.companies.map((company) => (
                <TableRow key={company.id} className="align-top">
                  <TableCell className="min-w-40 whitespace-normal">
                    <div className="flex flex-col items-start gap-1">
                      <span className="font-medium [overflow-wrap:anywhere]">
                        {company.company}
                      </span>
                      {/* OPEN[designer] FE3-6: no copy for the crypto flag; shown as a warning badge plus the research note. */}
                      {company.isCrypto && (
                        <Badge variant="warning">Crypto</Badge>
                      )}
                      {company.note && (
                        <span className="text-xs text-muted-foreground">
                          {company.note}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{company.applicationSystem}</TableCell>
                  <TableCell className="max-w-[28rem] min-w-64 font-mono text-[13px] whitespace-normal [overflow-wrap:anywhere]">
                    {company.boardUrl}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {!list.approvedAt && (
          <div className="pt-3">
            <Button onClick={() => setConfirming(true)}>
              {jobSourceCopy.approveButton}
            </Button>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title={jobSourceCopy.confirm.title}
              body={jobSourceCopy.confirm.body(n)}
              confirmLabel={jobSourceCopy.confirm.confirm}
              pendingLabel="Approving…"
              isPending={isApproving}
              onConfirm={approve}
            />
          </div>
        )}
      </div>
    </Section>
  )
}
