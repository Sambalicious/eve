import { AsyncLocalStorage } from "node:async_hooks"

/**
 * The Candidate a unit of work runs for (architecture r2, Tenancy mechanism 4).
 * Set in exactly two places: the api's session interceptor (from the session's
 * `candidate_id`) and the worker's job runners (the Operator in A1, or a job
 * payload's `candidateId`). Nothing reads it from a request body or header.
 *
 * It carries only the ID. Work that outlives one transaction (an AI call, a
 * browser attempt) keeps the scope while each repository statement opens its
 * own short `forCandidate` transaction.
 */
export class MissingCandidateScopeError extends Error {
  constructor() {
    super("No Candidate scope: Candidate data is read only inside a session or a Candidate job")
    this.name = "MissingCandidateScopeError"
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function assertCandidateId(candidateId: string): string {
  if (!UUID.test(candidateId)) throw new Error("Refused: not a Candidate ID")
  return candidateId.toLowerCase()
}

const storage = new AsyncLocalStorage<string>()

export const CandidateScope = {
  run<T>(candidateId: string, work: () => T): T {
    return storage.run(assertCandidateId(candidateId), work)
  },
  /** The scope's Candidate, or undefined outside any scope. */
  current(): string | undefined {
    return storage.getStore()
  },
  require(): string {
    const id = storage.getStore()
    if (id === undefined) throw new MissingCandidateScopeError()
    return id
  },
}
