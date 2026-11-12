import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common"
import type { ConvertedFeature } from "@eve/contracts"
import { type Job, PgBoss, type Queue, type ScheduleOptions, type SendOptions, type WorkOptions } from "pg-boss"

import { assertCandidateId } from "../db/candidate-scope.js"

export const WORKER_CONFIG = Symbol("WORKER_CONFIG")

declare const sharedBrand: unique symbol
declare const candidateBrand: unique symbol

/**
 * A queue whose jobs act for no Candidate (architecture r1/r4, Worker job
 * scoping): schedules, installation jobs and system sweeps. Handlers that touch
 * Candidate data open each Candidate's scope themselves (identity table, then
 * `forCandidate`), as the Operator-only fan-outs do until their slices.
 */
export type SharedQueue = Readonly<{ name: string; kind: "shared"; [sharedBrand]: true }>

export type CandidateQueueOptions = Readonly<{
  /** Payloads queued before the job carried `candidateId` belong to the Operator (submission.sample before 0010). */
  legacyMissingIsOperator?: boolean
  /** Refuses non-Operator jobs until this feature's converting slice (architecture r3 "Fail closed before conversion"). */
  operatorOnlyUntil?: ConvertedFeature
}>

/** A queue whose every job acts for one Candidate, named by `candidateId` in its payload. `T` is the payload without it. */
export type CandidateQueue<T extends object> = Readonly<{ name: string; kind: "candidate"; options: CandidateQueueOptions; [candidateBrand]: T }>

type DeclaredQueue = SharedQueue | CandidateQueue<object>

/**
 * F-SEC-06: the private name-to-queue registry. A queue's kind is decided here,
 * when its name is first declared, not by the `kind` label on whatever object a
 * caller passes. A name is shared or Candidate for the life of the process, and
 * only the frozen object returned by its declaration opens a JobQueue method,
 * so a spread, relabelled or hand-built object is refused.
 */
const declared = new Map<string, DeclaredQueue>()

function declare<Q extends DeclaredQueue>(queue: Q): Q {
  const existing = declared.get(queue.name)
  if (existing === undefined) {
    Object.freeze(queue)
    declared.set(queue.name, queue)
    return queue
  }
  if (existing.kind !== queue.kind) throw new Error(`${queue.name} is ${describe(existing.kind)}: it cannot also be declared ${describe(queue.kind)}`)
  if (existing.kind === "candidate" && JSON.stringify(existing.options) !== JSON.stringify((queue as CandidateQueue<object>).options)) {
    throw new Error(`${queue.name} is already declared with other Candidate queue options`)
  }
  return existing as Q
}

const describe = (kind: DeclaredQueue["kind"]): string => (kind === "shared" ? "a shared queue" : "a Candidate queue")

export const sharedQueue = (name: string): SharedQueue => declare({ name, kind: "shared" } as SharedQueue)
export const candidateQueue = <T extends object>(name: string, options: CandidateQueueOptions = {}): CandidateQueue<T> =>
  declare({ name, kind: "candidate", options: Object.freeze({ ...options }) } as CandidateQueue<T>)

/**
 * Returns the declared queue `queue` stands for, or throws. The name decides
 * the kind: a Candidate name is refused by the shared methods and a shared name
 * by the Candidate methods, whatever label the object carries.
 */
function requireDeclared(queue: SharedQueue, kind: "shared"): SharedQueue
function requireDeclared<T extends object>(queue: CandidateQueue<T>, kind: "candidate"): CandidateQueue<T>
function requireDeclared(queue: DeclaredQueue, kind: DeclaredQueue["kind"]): DeclaredQueue {
  const name = typeof queue?.name === "string" ? queue.name : String(queue?.name)
  const entry = declared.get(name)
  if (entry !== undefined && entry.kind !== kind) {
    throw new Error(entry.kind === "candidate" ? `${name} is a Candidate queue: use sendForCandidate, and register its handler with CandidateJobRunner.work` : `${name} is a shared queue: use sendShared`)
  }
  if (entry !== queue) throw new Error(`${name} is not a declared ${kind === "shared" ? "shared" : "Candidate"} queue`)
  return entry
}

function requireAnyDeclared(queue: DeclaredQueue): DeclaredQueue {
  const entry = declared.get(queue?.name)
  if (entry === undefined) throw new Error(`${String(queue?.name)} is not a declared queue`)
  return entry.kind === "shared" ? requireDeclared(queue as SharedQueue, "shared") : requireDeclared(queue as CandidateQueue<object>, "candidate")
}

/**
 * F-SEC-08: the registry entry a Candidate queue object stands for, or throws.
 * CandidateJobRunner reads the name and options from the returned entry, never
 * from the caller's object, so a hand-built, copied, spread or relabelled
 * object cannot pick a shared or undeclared name or drop `operatorOnlyUntil`.
 */
export function requireDeclaredCandidate<T extends object>(queue: CandidateQueue<T>): CandidateQueue<T> {
  return requireDeclared(queue, "candidate")
}

/** The payload a Candidate job carries on the wire. */
export type CandidateJobData<T extends object> = T & { candidateId: string }

/** Registers a Candidate handler on the pg-boss instance behind a JobQueue. */
export type CandidateWorkerRegistration = (
  jobQueue: JobQueue,
  queue: CandidateQueue<object>,
  options: WorkOptions,
  handler: (jobs: Job<object>[]) => Promise<void>
) => Promise<string>

let registerCandidateWorker: CandidateWorkerRegistration | undefined
let claimedBy: string | undefined

/**
 * Owns the pg-boss instance in the worker process and is the only door to it
 * (EPIC-0002 A2). Every job is shared or Candidate, decided by queue:
 * `sendShared` / `workShared` for shared queues, `sendForCandidate` for
 * Candidate queues, and `CandidateJobRunner.work` is the only way to register a
 * Candidate handler.
 *
 * F-SEC-02: the pg-boss instance is a `#private` field, so no property access
 * (`q.x`, `q[k]`, destructuring, `Reflect.get`) returns it. Candidate handler
 * registration goes through a one-shot capability that CandidateJobRunner
 * claims when its module loads (`claimCandidateWorker`); a second claim throws.
 */
@Injectable()
export class JobQueue implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobQueue.name)
  readonly #boss: PgBoss

  static {
    // F-SEC-08: the registration resolves the name through the registry itself, so only a declared Candidate queue gets a handler.
    registerCandidateWorker = (jobQueue, queue, options, handler) => jobQueue.#boss.work<object>(requireDeclared(queue, "candidate").name, options, handler as never)
  }

  constructor(@Inject(WORKER_CONFIG) config: { databaseUrl: string }) {
    // The runtime role cannot run DDL (SEC-001); the migrate step installs the schema.
    this.#boss = new PgBoss({ connectionString: config.databaseUrl, migrate: false })
    this.#boss.on("error", (error: Error) => this.logger.error(`pg-boss: ${error.message}`))
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.#boss.start()
    this.logger.log("pg-boss started")
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#boss.stop({ graceful: true })
  }

  async createQueue(queue: SharedQueue | CandidateQueue<object>, options?: Omit<Queue, "name">): Promise<void> {
    return this.#boss.createQueue(requireAnyDeclared(queue).name, options)
  }

  async schedule(queue: SharedQueue, cron: string, options?: ScheduleOptions): Promise<void> {
    return this.#boss.schedule(requireDeclared(queue, "shared").name, cron, null, options)
  }

  async unschedule(queue: SharedQueue): Promise<void> {
    return this.#boss.unschedule(requireDeclared(queue, "shared").name)
  }

  /** A shared job: its payload never names a Candidate. */
  async sendShared(queue: SharedQueue, data: object, options?: SendOptions): Promise<string | null> {
    requireDeclared(queue, "shared")
    if ("candidateId" in data) throw new Error(`A ${queue.name} job carries no Candidate ID`)
    return this.#boss.send(queue.name, data, options)
  }

  /** A Candidate job: the ID goes into the payload, where CandidateJobRunner reads it. */
  async sendForCandidate<T extends object>(queue: CandidateQueue<T>, candidateId: string, data: T, options?: SendOptions): Promise<string | null> {
    requireDeclared(queue, "candidate")
    let id: string
    try {
      id = assertCandidateId(candidateId)
    } catch {
      throw new Error(`Refused a ${queue.name} job: not a Candidate ID`)
    }
    const payload: CandidateJobData<T> = { ...data, candidateId: id }
    return this.#boss.send(queue.name, payload, options)
  }

  /** Registers a shared handler. Candidate handlers go through CandidateJobRunner.work. */
  async workShared<O extends WorkOptions>(queue: SharedQueue, options: O, handler: (jobs: Job<object>[]) => Promise<void>): Promise<string> {
    requireDeclared(queue, "shared")
    return this.#boss.work<object>(queue.name, options, handler as never)
  }
}

/**
 * Hands out the Candidate handler registration once. candidate-job-runner.ts
 * claims it at module load, before any other module can; lint restricts the
 * import to that file. Every later claim throws.
 */
export function claimCandidateWorker(claimant = "CandidateJobRunner"): CandidateWorkerRegistration {
  if (claimedBy !== undefined || registerCandidateWorker === undefined) throw new Error(`The Candidate worker registration is already claimed by ${claimedBy ?? "nobody"}`)
  claimedBy = claimant
  const registration = registerCandidateWorker
  registerCandidateWorker = undefined
  return registration
}

