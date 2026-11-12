import { queryOptions } from "@tanstack/react-query"

import { fetchRequisitionRecords } from "../api/requisition-record-repository"

export const requisitionRecordsQueryKey = ["requisition-records"] as const

export function requisitionRecordsQueryOptions() {
  return queryOptions({ queryKey: requisitionRecordsQueryKey, queryFn: fetchRequisitionRecords })
}
