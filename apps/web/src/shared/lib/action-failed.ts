import { toast } from "@/shared/ui/toast"

/** C-ERR-2: "Couldn't {action}. Nothing changed. Try again." */
export function actionFailedMessage(action: string): string {
  return `Couldn't ${action}. Nothing changed. Try again.`
}

/** Shows C-ERR-2 as an error toast in the app toaster's polite region (design-spec.r3). */
export function toastActionFailed(action: string): void {
  toast.error(actionFailedMessage(action))
}

/** A success toast, such as "Saved.". */
export function toastSuccess(title: string): void {
  toast.success(title)
}

/** An error toast with a refusal the API explained, such as a contract error message. */
export function toastError(title: string): void {
  toast.error(title)
}
