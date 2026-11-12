import { Injectable } from "@nestjs/common"
import type { Lead, LeadStage, LeadsResponse } from "@eve/contracts"

import { CLOCK, type Clock } from "../shared/clock.js"
import { LeadsRepository } from "./leads.repository.js"
import { Inject } from "@nestjs/common"

/** v1.29.0: the Candidate's own stages. Not an Application; no documents, no submission. */
@Injectable()
export class LeadsService {
  constructor(
    private readonly repository: LeadsRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  list(): Promise<LeadsResponse> {
    return this.repository.list()
  }

  setStage(jobPostingId: string, stage: LeadStage): Promise<Lead | undefined> {
    return this.repository.setStage(jobPostingId, stage, this.clock.now())
  }

  remove(jobPostingId: string): Promise<boolean> {
    return this.repository.remove(jobPostingId)
  }
}
