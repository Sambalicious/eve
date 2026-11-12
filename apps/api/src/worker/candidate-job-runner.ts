import { Injectable, Logger } from "@nestjs/common"
import type { Job, WorkOptions } from "pg-boss"

import { CandidateScope, assertCandidateId } from "../db/candidate-scope.js"
import { TenantDatabase } from "../db/tenant-database.js"
import { capabilityFor } from "../shared/converted-features.js"
import { type CandidateQueue, JobQueue, claimCandidateWorker, requireDeclaredCandidate } from "./job-queue.js"

/** F-SEC-02: claimed at module load, so no other module can register a Candidate handler. */
const registerCandidateWorker = claimCandidateWorker()

export type CandidateJobRefusal = "missing_candidate_id" | "candidate_not_active" | "feature_not_yet_available"
export type CandidateJobResult = { result: "ran"; candidateId: string } | { result: "refused"; reason: CandidateJobRefusal }

/** A Candidate handler: runs inside the job Candidate's scope, so every repository opens `forCandidate` for that ID only. */
export type CandidateHandler<T extends object> = (candidateId: string, data: T) => Promise<unknown>

/**
 * The only way to register a Candidate job handler (EPIC-0002 A2; architecture
 * r1/r4 Worker job scoping). Before the handler runs it: reads `candidateId`
 * from the payload (a missing one is refused, or is the Operator on a queue
 * with pre-migration payloads); refuses an unknown, revoked or deleting
 * Candidate; refuses a non-Operator on an Operator-only queue until its
 * feature converts. Then it runs the handler in that Candidate's scope, so the
 * handler's repositories see only that Candidate's rows (RLS). A refused job
 * completes with a logged reason and is not retried.
 *
 * F-SEC-08: `work` and `run` first resolve the queue through the JobQueue
 * registry and use only the registered entry's name and options. An object
 * that is not the declared Candidate queue throws.
 */
@Injectable()
export class CandidateJobRunner {
  private readonly logger = new Logger(CandidateJobRunner.name)

  constructor(
    private readonly queue: JobQueue,
    private readonly tenant: TenantDatabase
  ) {}

  async work<T extends object, O extends WorkOptions>(queue: CandidateQueue<T>, options: O, handler: CandidateHandler<T>): Promise<string> {
    const declared = requireDeclaredCandidate(queue)
    return registerCandidateWorker(this.queue, declared, options, async (jobs: Job<object>[]) => {
      for (const job of jobs) await this.run(declared, job.data, handler)
    })
  }

  async run<T extends object>(caller: CandidateQueue<T>, data: unknown, handler: CandidateHandler<T>): Promise<CandidateJobResult> {
    const queue = requireDeclaredCandidate(caller)
    const payload = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>
    const { candidateId: raw, ...rest } = payload
    const candidateId = await this.resolve(queue, raw)
    if (candidateId === undefined) return this.refuse(queue, "missing_candidate_id")
    const identity = await this.tenant.candidateIdentity(candidateId)
    if (identity?.state !== "active") return this.refuse(queue, "candidate_not_active")
    const feature = queue.options.operatorOnlyUntil
    if (feature !== undefined && capabilityFor(feature, identity.role === "operator") !== "available") return this.refuse(queue, "feature_not_yet_available")
    await CandidateScope.run(candidateId, () => handler(candidateId, rest as T))
    return { result: "ran", candidateId }
  }

  private async resolve(queue: CandidateQueue<object>, raw: unknown): Promise<string | undefined> {
    if (raw === undefined && queue.options.legacyMissingIsOperator === true) return this.tenant.operatorId()
    if (typeof raw !== "string") return undefined
    try {
      return assertCandidateId(raw)
    } catch {
      return undefined
    }
  }

  private refuse(queue: CandidateQueue<object>, reason: CandidateJobRefusal): CandidateJobResult {
    // IDs and reason codes only (AC 6.7): no payload content is logged.
    this.logger.warn(`Refused a ${queue.name} job: ${reason}`)
    return { result: "refused", reason }
  }
}
