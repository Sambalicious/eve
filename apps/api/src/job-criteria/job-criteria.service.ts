import { performance } from "node:perf_hooks"

import { Injectable, Logger } from "@nestjs/common"
import type { JobCriteriaRequest, JobCriteriaResponse } from "@eve/contracts"

import type { StoredJobCriteria } from "../discovery/discovery.repository.js"
import { JobCriteriaRepository } from "./job-criteria.repository.js"

/** Over this, the save also logs a warning (architecture "Observability"). */
const SLOW_SAVE_MS = 2_000

/**
 * The Candidate's Job criteria (EPIC-0004). Depends on no ModelGateway,
 * SpendLedger or fetch: a save re-decides from stored evidence only (AC 5.3).
 */
@Injectable()
export class JobCriteriaService {
  private readonly logger = new Logger(JobCriteriaService.name)

  constructor(private readonly repository: JobCriteriaRepository) {}

  async read(): Promise<JobCriteriaResponse> {
    return toResponse(await this.repository.read())
  }

  /** Last successful save wins (AC 1.4). Save and re-decision succeed or fail together (AC 5.5). */
  async save(request: JobCriteriaRequest): Promise<JobCriteriaResponse> {
    const started = performance.now()
    let result
    try {
      result = await this.repository.saveAndRedecide(request)
    } catch (error) {
      this.logger.error(JSON.stringify({ event: "job_criteria.save_failed", error: error instanceof Error ? error.name : "unknown" }))
      throw error
    }
    const { criteria, considered, changed } = result
    const line = {
      event: "job_criteria.saved",
      version: criteria.version,
      minCoreMatchPercent: criteria.minCoreMatchPercent,
      frameworks: criteria.frameworks.length,
      technologies: criteria.technologies.length,
      targetRoleFamilies: criteria.targetRoleFamilies.length,
      seniorityFloor: criteria.seniorityFloor,
      redecided: result.redecided,
      considered,
      changed: changed.length,
      changedToRanked: changed.filter((row) => row.status === "ranked").length,
      changedToSkipped: changed.filter((row) => row.status === "skipped" && row.previousStatus === "ranked").length,
      durationMs: Math.round(performance.now() - started),
    }
    this.logger.log(JSON.stringify(line))
    if (line.durationMs > SLOW_SAVE_MS) this.logger.warn(JSON.stringify({ ...line, event: "job_criteria.save_slow" }))
    return toResponse(criteria)
  }
}

function toResponse(criteria: StoredJobCriteria): JobCriteriaResponse {
  return {
    minCoreMatchPercent: criteria.minCoreMatchPercent,
    frameworks: [...criteria.frameworks],
    technologies: [...criteria.technologies],
    targetRoleFamilies: [...criteria.targetRoleFamilies],
    seniorityFloor: criteria.seniorityFloor,
    version: criteria.version,
  }
}
