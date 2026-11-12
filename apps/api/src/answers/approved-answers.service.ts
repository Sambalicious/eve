import { randomUUID } from "node:crypto"

import { Inject, Injectable } from "@nestjs/common"
import {
  type ApprovedAnswer,
  type CreateApprovedAnswerRequest,
  sensitiveAnswerTopicSchema,
  standardAnswerTopicSchema,
} from "@eve/contracts"

import { ApiException } from "../http/api-exception.js"
import { CLOCK, type Clock } from "../shared/clock.js"
import { approvedAnswerKey } from "./approved-answer-key.js"
import { type ApprovedAnswerRow, ApprovedAnswersRepository } from "./approved-answers.repository.js"

@Injectable()
export class ApprovedAnswersService {
  constructor(
    private readonly repository: ApprovedAnswersRepository,
    @Inject(CLOCK) private readonly clock: Clock
  ) {}

  async list(): Promise<ApprovedAnswer[]> {
    return (await this.repository.list()).map(toApprovedAnswer)
  }

  async create(request: CreateApprovedAnswerRequest): Promise<ApprovedAnswer> {
    if (request.group === "custom" && request.question.trim() === "") {
      throw new ApiException("approved_answer_question_empty")
    }
    if (request.group === "standard" && request.topic === "skill_years" && request.skill === undefined) {
      throw new ApiException("bad_request")
    }
    if (request.group === "standard" && request.topic !== "skill_years" && request.skill !== undefined) {
      throw new ApiException("bad_request")
    }
    const value = requireValue(request.value)
    const now = this.clock.now()
    const row = await this.repository.insert({
      id: randomUUID(),
      answer_group: request.group,
      topic: request.group === "custom" ? null : request.topic,
      skill: request.group === "standard" ? (request.skill ?? null) : null,
      question: request.group === "custom" ? request.question.trim() : null,
      answer_key: approvedAnswerKey(request),
      value,
      created_at: now,
      updated_at: now,
    })
    if (!row) throw new ApiException("approved_answer_exists")
    return toApprovedAnswer(row)
  }

  async update(id: string, rawValue: string): Promise<ApprovedAnswer> {
    const row = await this.repository.updateValue(id, requireValue(rawValue), this.clock.now())
    if (!row) throw new ApiException("not_found")
    return toApprovedAnswer(row)
  }

  async delete(id: string): Promise<void> {
    if (!(await this.repository.delete(id))) throw new ApiException("not_found")
  }
}

function requireValue(raw: string): string {
  const value = raw.trim()
  if (value === "") throw new ApiException("approved_answer_value_empty")
  return value
}

function toApprovedAnswer(row: ApprovedAnswerRow): ApprovedAnswer {
  const updatedAt = row.updated_at.toISOString()
  switch (row.answer_group) {
    case "standard":
      return {
        id: row.id,
        group: "standard",
        topic: standardAnswerTopicSchema.parse(row.topic),
        skill: row.skill,
        value: row.value,
        updatedAt,
      }
    case "sensitive":
      return { id: row.id, group: "sensitive", topic: sensitiveAnswerTopicSchema.parse(row.topic), value: row.value, updatedAt }
    case "custom":
      return { id: row.id, group: "custom", question: row.question ?? "", value: row.value, updatedAt }
  }
}
