import { useQuery } from "@tanstack/react-query"

import { formAnswersQueryOptions } from "@/entities/application"

/** The planned answers for a sample's form (C-SAMPLE-14 to 17); shared by the panel and the C-SAMPLE-8 warning. */
export function useFormAnswers(applicationId: string) {
  return useQuery(formAnswersQueryOptions(applicationId))
}
