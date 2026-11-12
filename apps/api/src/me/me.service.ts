import { Inject, Injectable } from "@nestjs/common"
import type { MeNote, MeResponse } from "@eve/contracts"

import { CandidateIdentityRepository } from "../auth/candidate-identity.repository.js"
import { TenantDatabase } from "../db/tenant-database.js"
import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { capabilityFor } from "../shared/converted-features.js"
import { dismissImproveList, dismissSimplerNote, lockActivation, readViewState, upsertAdvanced } from "./view-setting.js"

/** `GET /v1/me` and the C2 writes (contract v1.28.0). Every statement runs in the session Candidate's tenant transaction. */
@Injectable()
export class MeService {
  constructor(
    private readonly identities: CandidateIdentityRepository,
    private readonly tenant: TenantDatabase,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async read(candidateId: string): Promise<MeResponse> {
    const view = await this.tenant.run((tx, id) => readViewState(tx, id))
    return this.body(candidateId, view)
  }

  /** Lock `activation_state`, refuse off-while-automatic, upsert the flag, read back: one transaction. */
  async setAdvanced(candidateId: string, enabled: boolean): Promise<MeResponse> {
    const view = await this.tenant.run(async (tx, id) => {
      const automatic = await lockActivation(tx, id)
      if (!enabled && automatic) throw new ApiException("advanced_locked")
      await upsertAdvanced(tx, id, enabled, this.clock.now())
      return readViewState(tx, id)
    })
    return this.body(candidateId, view)
  }

  async dismiss(candidateId: string, note: MeNote): Promise<MeResponse> {
    const view = await this.tenant.run(async (tx, id) => {
      if (note === "simpler_now") await dismissSimplerNote(tx, id, this.clock.now())
      else await dismissImproveList(tx, id, this.clock.now())
      return readViewState(tx, id)
    })
    return this.body(candidateId, view)
  }

  private async body(candidateId: string, view: Awaited<ReturnType<typeof readViewState>>): Promise<MeResponse> {
    const row = await this.identities.identity(candidateId)
    if (!row) throw new ApiException("unauthenticated")
    const isOperator = row.role === "operator"
    return {
      candidateId: row.id,
      email: row.email,
      isOperator,
      capabilities: {
        submission: capabilityFor("submission", isOperator),
        notifications: capabilityFor("notifications", isOperator),
        spend: capabilityFor("spend", isOperator),
      },
      ...view,
    }
  }
}
