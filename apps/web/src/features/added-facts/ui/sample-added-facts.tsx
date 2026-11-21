import type { AddedFactUsed } from "@eve/contracts"
import { Link } from "react-router-dom"

import { Section } from "@/shared/ui/section"

import { addedFactsCopy, atsAddedCopy, roleLabel } from "../model/copy"

/**
 * The Activation Gate sample's read-only Added list (design-spec.r1 blueprint 8, C-AF-85 to C-AF-87).
 * Only the facts the sample's documents cited, as they were at generation; editing stays on the
 * Application page.
 */
export function SampleAddedFacts({ applicationId, cited }: { applicationId: string; cited: readonly AddedFactUsed[] }) {
  return (
    <Section title={addedFactsCopy.sample.heading}>
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {cited.map((fact) => (
            <li key={fact.id} className="flex flex-col gap-0.5">
              <p className="text-sm [overflow-wrap:anywhere]">
                <bdi>{fact.text}</bdi>
              </p>
              <p className="flex flex-wrap items-baseline gap-x-1.5 text-[13px] text-muted-foreground">
                <span>{fact.kind === "skill_only" ? atsAddedCopy.kind.skillOnly : atsAddedCopy.kind.oneLiner}</span>
                {fact.role !== null && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="[overflow-wrap:anywhere]">{addedFactsCopy.role(roleLabel(fact.role))}</span>
                  </>
                )}
              </p>
            </li>
          ))}
        </ul>
        <Link to={`/applications/${encodeURIComponent(applicationId)}#added-facts`} className="w-fit text-sm underline underline-offset-4">
          {addedFactsCopy.sample.editLink}
        </Link>
      </div>
    </Section>
  )
}
