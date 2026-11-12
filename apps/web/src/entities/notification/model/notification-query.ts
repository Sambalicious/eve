import { queryOptions } from "@tanstack/react-query"

import { fetchNotificationStatus } from "../api/notification-repository"

export const notificationStatusQueryKey = ["notifications", "status"] as const

export function notificationStatusQueryOptions() {
  return queryOptions({ queryKey: notificationStatusQueryKey, queryFn: fetchNotificationStatus })
}
