import { Section } from "@/shared/ui/section"
import { PasteJobLinkForm } from "./paste-job-link-form"

/** Help under the field (copy deck: no slot for this line; proposal, no automation or Manual Application wording). */
const HELP = "Paste a link to a job. Eve checks how well it fits your profile."

/**
 * "Add a job link" (Home and `/postings`): input group with the Link2 icon and
 * "Check link". Validation shows inline under the field; focus returns to it.
 * The C-LINK-2 and EPIC-0006 B7 hidden status lines live in `PasteJobLinkForm`.
 */
export function AddJobLink({ className }: { className?: string }) {
  return (
    <Section title="Add a job link" className={className}>
      <div className="max-w-xl">
        <PasteJobLinkForm kind="add" label="Job link" help={HELP} />
      </div>
    </Section>
  )
}
