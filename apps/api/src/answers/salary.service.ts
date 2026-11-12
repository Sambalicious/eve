import { Inject, Injectable } from "@nestjs/common"
import type {
  GrossSalary,
  PreferredNetPay,
  SalaryResponse,
  setGrossSalaryRequestSchema,
  setPreferredNetPayRequestSchema,
} from "@eve/contracts"
import type { z } from "zod"

import { CLOCK, type Clock } from "../shared/clock.js"
import { formatSalary } from "./salary-display.js"
import { type GrossKind, type GrossRow, type NetRow, SalaryRepository } from "./salary.repository.js"

type ParsedGross = z.output<typeof setGrossSalaryRequestSchema>
type ParsedNet = z.output<typeof setPreferredNetPayRequestSchema>

@Injectable()
export class SalaryService {
  constructor(
    private readonly repository: SalaryRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async read(): Promise<SalaryResponse> {
    const [policy, current, net] = await Promise.all([
      this.repository.findGross("gross_salary_policy"),
      this.repository.findGross("current_salary"),
      this.repository.findNet(),
    ])
    return {
      grossSalaryPolicy: policy ? toGross(policy) : null,
      currentSalary: current ? toGross(current) : null,
      preferredNetPay: net ? toNet(net) : null,
    }
  }

  /** A gross value used to fill a gross-salary form field. Never reads the net table. */
  async grossSalaryPolicyForForms(): Promise<GrossSalary | null> {
    const row = await this.repository.findGross("gross_salary_policy")
    return row ? toGross(row) : null
  }

  async setGross(kind: GrossKind, request: ParsedGross): Promise<SalaryResponse> {
    await this.repository.upsertGross({
      kind,
      amount: request.amount.toFixed(2),
      currency: request.currency,
      period: request.period,
      updated_at: this.clock.now(),
    })
    return this.read()
  }

  async clearGross(kind: GrossKind): Promise<SalaryResponse> {
    await this.repository.deleteGross(kind)
    return this.read()
  }

  async setNet(request: ParsedNet): Promise<SalaryResponse> {
    await this.repository.upsertNet(request.amount.toFixed(2), request.currency, this.clock.now())
    return this.read()
  }

  async clearNet(): Promise<SalaryResponse> {
    await this.repository.deleteNet()
    return this.read()
  }

  workAuthorization(): Promise<string> {
    return this.repository.readWorkAuthorization()
  }

  async setWorkAuthorization(value: string): Promise<string> {
    await this.repository.writeWorkAuthorization(value, this.clock.now())
    return this.repository.readWorkAuthorization()
  }
}

function toGross(row: GrossRow): GrossSalary {
  return {
    amount: Number(row.amount),
    currency: row.currency,
    period: row.period,
    display: formatSalary(row.amount, row.currency, row.period),
  }
}

function toNet(row: NetRow): PreferredNetPay {
  return {
    amount: Number(row.amount),
    currency: row.currency,
    period: "month_net",
    display: formatSalary(row.amount, row.currency, "month_net"),
  }
}
