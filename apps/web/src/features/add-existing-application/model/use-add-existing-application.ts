import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { ApiErrorCode } from "@eve/contracts"

import {
  addExistingApplication,
  existingApplicationCopy as c,
  existingApplicationsQueryKey,
  type ExistingApplication,
  type ExistingApplications,
  type NewExistingApplication,
} from "@/entities/existing-application"
import { ensureCsrfToken } from "@/entities/session"
import { ApiError } from "@/shared/api"
import { toastActionFailed, toastSuccess } from "@/shared/lib/action-failed"
import type { ExistingApplicationField } from "./existing-application-form"

const EMPTY_FIELD_CODES: Partial<
  Record<ApiErrorCode, ExistingApplicationField>
> = {
  existing_application_company_empty: "company",
  existing_application_role_empty: "roleTitle",
  existing_application_url_empty: "applicationUrl",
  existing_application_date_empty: "appliedOn",
}

interface Callbacks {
  /** 201: a new record. The list in the cache already has it at the end. */
  onAdded: () => void
  /** 200 `created: false`: nothing new; `application` is the stored record (C-EXIST-3). */
  onAlreadyRecorded: (application: ExistingApplication) => void
  /** 422 `existing_application_*_empty`: C-VAL-EXIST-1 under that field. */
  onFieldError: (field: ExistingApplicationField, message: string) => void
  /** 400 `bad_request`: the response doesn't say which field (C-VAL-EXIST-2, one inline alert). */
  onBadRequest: () => void
}

/**
 * Records one existing application (F1 step 6a). Network and server failures
 * are a C-ERR-2 toast and the form keeps its values.
 */
export function useAddExistingApplication({
  onAdded,
  onAlreadyRecorded,
  onFieldError,
  onBadRequest,
}: Callbacks) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (application: NewExistingApplication) =>
      addExistingApplication(application, await ensureCsrfToken(queryClient)),
    onSuccess: (result) => {
      if (!result.created) return onAlreadyRecorded(result.application)
      queryClient.setQueryData<ExistingApplications>(
        existingApplicationsQueryKey,
        (list) =>
          list
            ? {
                ...list,
                applications: [...list.applications, result.application],
              }
            : list
      )
      void queryClient.invalidateQueries({
        queryKey: existingApplicationsQueryKey,
      })
      toastSuccess(c.added)
      onAdded()
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code) {
        const field = EMPTY_FIELD_CODES[error.code]
        if (field) return onFieldError(field, c.empties[field])
        if (error.code === "bad_request") return onBadRequest()
      }
      toastActionFailed(c.failedActions.add)
    },
  })
  return { add: mutation.mutate, isAdding: mutation.isPending }
}
