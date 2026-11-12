/**
 * EPIC-0002 D13 / EPIC-0006 (architecture.r1 "Check again"; threat model TM-01,
 * TM-05): before slice D only the Operator's postings are evaluated. The one
 * rule that Check again (`movedTo`), storing a posting (`storeOnce`: the
 * paste response's starting state), the worker's `evaluate.posting` handler
 * and the evaluator all read. Slice D changes it here.
 */
export function evaluationAllowed(candidate: Readonly<{ role: string; state: string }> | undefined): boolean {
  return candidate !== undefined && candidate.state === "active" && candidate.role === "operator"
}
