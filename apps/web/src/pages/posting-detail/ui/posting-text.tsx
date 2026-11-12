import { useId, useState } from "react"

import { jobPostingCopy } from "@/entities/job-posting"
import { Button } from "@/shared/ui/button"
import { Section } from "@/shared/ui/section"

/**
 * The stored posting text, rendered as text (it is untrusted, never HTML).
 * Collapsed to 12 lines with "Show full posting". `note` (C-PD-41) says the
 * Candidate pasted it.
 */
export function PostingText({ text, note }: { text: string; note?: string }) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const isLong = text.split("\n").length > 12 || text.length > 1200
  return (
    <Section title="Posting" description={note} headingProps={{ id: `${id}-heading` }}>
      <p
        id={`${id}-text`}
        className={`max-w-[72ch] text-sm whitespace-pre-line [overflow-wrap:anywhere] ${isLong && !expanded ? "line-clamp-12" : ""}`}
      >
        {text}
      </p>
      {isLong && (
        <Button
          variant="link"
          className="px-0"
          aria-expanded={expanded}
          aria-controls={`${id}-text`}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? jobPostingCopy.showLess : jobPostingCopy.showFullPosting}
        </Button>
      )}
    </Section>
  )
}
