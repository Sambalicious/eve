import type { CandidateFiles } from "../files/candidate-files.js"

/**
 * A stored Tailored Document handed to the browser seam (F-SEC-03). It carries
 * no path: the bytes come only through `CandidateFiles.read`, which opens with
 * O_NOFOLLOW and refuses a symlinked Candidate or area directory. `name` is the
 * server-chosen `<uuid>.pdf`, used as the upload's file name.
 */
export type StoredDocument = Readonly<{
  name: string
  read: () => Promise<Buffer>
}>

export function storedDocument(files: CandidateFiles, candidateId: string, storageName: string): StoredDocument {
  // Validates the ID and name now (no I/O), so a bad row fails before the browser is touched.
  files.path(candidateId, "documents", storageName)
  return { name: storageName, read: () => files.read(candidateId, "documents", storageName) }
}
