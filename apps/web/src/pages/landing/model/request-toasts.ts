/**
 * The request dialog's own toaster and its load-failure toast id (design-spec
 * r3 Toasts). The form gives each send failure a fresh `${toasterId}-send-N`
 * id and dismisses the previous one first (F-QA-E3C-02), so one shows at a time.
 */
export const REQUEST_TOASTER = "request-access"

export const REQUEST_TOAST_IDS = {
  load: `${REQUEST_TOASTER}-load`,
} as const
