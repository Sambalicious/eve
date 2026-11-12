import { useState } from "react"
import { CircleCheck, ExternalLink } from "lucide-react"

import { aiProviderCopy, type AiProvider } from "@/entities/ai-provider"
import { formatWatDate } from "@/shared/lib/format-wat"
import { Button } from "@/shared/ui/button"
import { Section } from "@/shared/ui/section"
import { ConfirmDialog } from "@/shared/ui/confirm-dialog"
import { useApproveAiProvider } from "../model/use-approve-ai-provider"

/**
 * Data and privacy, "AI provider" (`#ai-provider`). Before approval: heading
 * C-AI-2, terms summary C-AI-3, source line C-AI-4 and "Approve Anthropic"
 * with C-CONFIRM-15. After approval: C-AI-5 with the recorded terms.
 */
export function AiProviderCard({ provider }: { provider: AiProvider }) {
  const [confirming, setConfirming] = useState(false)
  const { approve, isApproving } = useApproveAiProvider({
    onApproved: () => setConfirming(false),
  })
  const { terms, approval } = provider

  return (
    <Section
      id="ai-provider"
      title={aiProviderCopy.heading}
      layout="split"
      headingProps={{ id: "ai-provider-heading" }}
    >
      <div className="flex flex-col gap-3">
        {approval ? (
          <div className="flex gap-2 text-sm">
            <CircleCheck
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-success-text"
            />
            <div className="flex max-w-[72ch] flex-col gap-1">
              <p>
                {aiProviderCopy.approved(formatWatDate(approval.approvedAt))}
              </p>
              <p>{approval.trainingLine}</p>
              <p>{approval.retentionLine}</p>
            </div>
          </div>
        ) : (
          <>
            <ul className="flex max-w-[72ch] flex-col gap-2 text-sm">
              <li>{terms.trainingLine}</li>
              <li>{terms.retentionLine}</li>
              <li>{terms.whatsSentLine}</li>
            </ul>
            <p className="text-xs text-muted-foreground">
              {aiProviderCopy.sourceLine(formatWatDate(terms.checkedOn))}{" "}
              <ExternalTermsLink
                href={terms.trainingTermsUrl}
                label={aiProviderCopy.trainingTerms}
              />
              {" · "}
              <ExternalTermsLink
                href={terms.retentionTermsUrl}
                label={aiProviderCopy.retentionTerms}
              />
            </p>
          </>
        )}
        {!approval && (
          <div className="pt-2">
            <Button onClick={() => setConfirming(true)}>
              {aiProviderCopy.approveButton}
            </Button>
            <ConfirmDialog
              open={confirming}
              onOpenChange={setConfirming}
              title={aiProviderCopy.confirm.title}
              body={aiProviderCopy.confirm.body}
              confirmLabel={aiProviderCopy.confirm.confirm}
              pendingLabel="Approving…"
              isPending={isApproving}
              onConfirm={() => approve(terms.checkedOn)}
            />
          </div>
        )}
      </div>
    </Section>
  )
}

function ExternalTermsLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 underline underline-offset-4 hover:text-foreground"
    >
      {label}
      <ExternalLink aria-hidden="true" className="size-3" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  )
}
