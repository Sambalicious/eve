import { mkdir, rm, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import { readRegularFile } from "../files/candidate-files.js"

export type DocumentFormat = "pdf" | "docx"

/** `<uuid>.pdf|docx`, the only names the server writes or reads. */
export const STORAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|docx)$/

/**
 * Writes a rendered Tailored Document as `<uuid>.pdf|docx` under `directory`:
 * directory 0700, file 0600, created exclusively. Same rules as stored resumes.
 */
export async function storeDocumentFile(directory: string, id: string, format: DocumentFormat, bytes: Buffer): Promise<string> {
  const name = `${id}.${format}`
  const target = pathOf(directory, name)
  await mkdir(resolve(directory), { recursive: true, mode: 0o700 })
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 })
  return name
}

/** Reads a stored document by the name the server chose. Any other name is refused, and a symlink is never followed (F-SEC-03). */
export async function readDocumentFile(directory: string, name: string): Promise<Buffer> {
  return readRegularFile(pathOf(directory, name))
}

/** Removes a stored document by the name the server chose (SEC-705: same name and root checks as reads). A missing file is fine. */
export async function removeDocumentFile(directory: string, name: string): Promise<void> {
  await rm(pathOf(directory, name), { force: true })
}

function pathOf(directory: string, name: string): string {
  if (!STORAGE_NAME.test(name)) throw new Error("Invalid document storage name")
  const root = resolve(directory)
  const target = resolve(join(root, name))
  if (!target.startsWith(root + sep)) throw new Error("Invalid document storage name")
  return target
}
