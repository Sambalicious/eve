import type { ApprovedAnswer, SensitiveTopic, StandardTopic } from "./approved-answer"

/** Topic names from design-spec.r2 (Approved Answers screen and gherkin topics), in display order. */
export const STANDARD_TOPIC_LABELS: Record<StandardTopic, string> = {
  notice_period: "Notice period",
  start_date: "Start date",
  skill_years: "Skill years",
  profile_links: "Profile links",
  relocation_willingness: "Relocation willingness",
}

export const SENSITIVE_TOPIC_LABELS: Record<SensitiveTopic, string> = {
  demographic: "Demographic",
  disability: "Disability",
  veteran_status: "Veteran status",
}

/** The row label: topic name, "Skill years: React", or the custom question as the form asks it. */
export function answerLabel(answer: ApprovedAnswer): string {
  switch (answer.group) {
    case "standard":
      return answer.topic === "skill_years" && answer.skill
        ? `${STANDARD_TOPIC_LABELS.skill_years}: ${answer.skill}`
        : STANDARD_TOPIC_LABELS[answer.topic]
    case "sensitive":
      return SENSITIVE_TOPIC_LABELS[answer.topic]
    case "custom":
      return answer.question
    default: {
      const exhaustive: never = answer
      return exhaustive
    }
  }
}
