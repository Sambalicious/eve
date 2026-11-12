import type { ResumeMediaType } from "@eve/contracts"

import type { CandidateFiles } from "../files/candidate-files.js"

const EXTENSION: Record<ResumeMediaType, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
}

/**
 * Writes an uploaded resume under the Candidate's `resumes` area with a name the
 * server chooses (`<uuid>.pdf|docx`). The uploaded file name never becomes part
 * of a path. EPIC-0002 A2: through CandidateFiles (0700 directories, 0600 file,
 * created exclusively).
 */
export async function storeResume(files: CandidateFiles, candidateId: string, id: string, mediaType: ResumeMediaType, bytes: Buffer): Promise<string> {
  const storageName = `${id}.${EXTENSION[mediaType]}`
  await files.write(candidateId, "resumes", storageName, bytes)
  return storageName
}

const MAX_DISPLAY_NAME = 255

/** The file name shown back to the Candidate: base name only, no control characters. */
export function displayFilename(uploaded: string | undefined): string {
  const base = (uploaded ?? "").split(/[\\/]/).pop() ?? ""
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_DISPLAY_NAME)
  return clean === "" ? "resume" : clean
}
