import { submissionCopy } from "@/entities/application"
import { Button } from "@/shared/ui/button"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { ReasonDialog } from "@/shared/ui/reason-dialog"
import type { useReviewSample } from "../model/use-review-sample"

const sc = submissionCopy.sample

interface Props {
  review: ReturnType<typeof useReviewSample>
  company: string
  /** The id of a note that describes the approval (g9 criteria note), when one shows. */
  approveDescribedBy?: string
}

/**
 * "Reject" and "Approve and submit" (F2 step 4). Below 768px the bar sticks to
 * the bottom of the viewport.
 */
export function SampleActionBar({ review, company, approveDescribedBy }: Props) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur md:static md:mx-0 md:justify-start md:border-0 md:bg-transparent md:p-0">
      <Button variant="outline" onClick={() => review.setDialog("reject")}>{sc.reject}</Button>
      <Button aria-busy={review.approve.isPending} aria-describedby={approveDescribedBy} disabled={review.approve.isPending} onClick={() => review.setDialog("approve")}>
        {review.approve.isPending ? sc.approving : sc.approve}
      </Button>
      <ConfirmDialog
        open={review.dialog === "approve"}
        onOpenChange={(open) => !open && review.setDialog(null)}
        title={sc.confirmApprove.title}
        body={sc.confirmApprove.body(company)}
        confirmLabel={sc.approve}
        pendingLabel={sc.approving}
        isPending={review.approve.isPending}
        onConfirm={review.approve.run}
      />
      <ReasonDialog
        open={review.dialog === "reject"}
        onOpenChange={(open) => !open && review.setDialog(null)}
        title={sc.rejectDialog.title}
        fieldLabel={sc.rejectDialog.field}
        confirmLabel={sc.rejectDialog.confirm}
        pendingLabel={sc.rejectDialog.pending}
        isPending={review.reject.isPending}
        emptyMessage={submissionCopy.validation.sampleReasonEmpty}
        tooLongMessage={submissionCopy.validation.reasonTooLong}
        maxLength={500}
        serverError={review.rejectError}
        onConfirm={review.reject.run}
      />
    </div>
  )
}
