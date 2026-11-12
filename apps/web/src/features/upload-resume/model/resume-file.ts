import { RESUME_MAX_BYTES } from "@eve/contracts"

/** Extensions the picker offers. The backend still decides by the file's bytes. */
export const RESUME_ACCEPT =
  ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"

/**
 * A quick check before upload so an obviously wrong file gets C-VAL-PROFILE-1
 * at once. The backend's content check is the source of truth.
 */
export function isAcceptableResume(file: File): boolean {
  return file.size > 0 && file.size <= RESUME_MAX_BYTES && /\.(pdf|docx)$/i.test(file.name)
}
