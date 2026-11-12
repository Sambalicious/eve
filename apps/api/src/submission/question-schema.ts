import { z } from "zod"

import type { BoardHttp } from "../discovery/sources/board-http.js"
import { decodeEntities, htmlToText } from "../discovery/sources/discovered-posting.js"
import type { FormField, SchemaQuestion } from "./answer-assignment.js"

/**
 * Scope 05d: the employer's structured question schema, fetched by backend
 * code from the ATS's public API, outside the browser. Only Greenhouse
 * publishes one (job board API `questions=true`). Lever and Ashby have none,
 * so their work-authorization questions always need an Approved Answer.
 */
export type QuestionSchemaSource = Readonly<{
  /** The schema for this posting's form, or null when there is none or it can't be read (the safe case: work questions block). */
  forPosting(target: Readonly<{ applicationSystem: string; applyUrl: string }>): Promise<readonly SchemaQuestion[] | null>
}>

export const QUESTION_SCHEMAS = Symbol("QUESTION_SCHEMAS")

export const noQuestionSchemas: QuestionSchemaSource = { forPosting: () => Promise.resolve(null) }

const GREENHOUSE_HOSTS = /^(boards|job-boards)(\.eu)?\.greenhouse\.io$/

/** Board token and numeric job id from a hosted Greenhouse apply URL; null for anything else. */
export function greenhouseJobRef(applyUrl: string): Readonly<{ token: string; jobId: string }> | null {
  let url: URL
  try {
    url = new URL(applyUrl)
  } catch {
    return null
  }
  if (!GREENHOUSE_HOSTS.test(url.hostname)) return null
  const match = /^\/([A-Za-z0-9_-]{1,100})\/jobs\/(\d{1,20})\/?$/.exec(url.pathname)
  return match ? { token: match[1] as string, jobId: match[2] as string } : null
}

const greenhouseJobSchema = z.object({
  questions: z
    .array(
      z.object({
        label: z.string(),
        fields: z.array(z.object({ name: z.string(), type: z.string().nullish(), values: z.array(z.object({ label: z.string() })).nullish() })),
      })
    )
    .nullish(),
})

export function createGreenhouseQuestionSchemas(http: BoardHttp): QuestionSchemaSource {
  return {
    async forPosting({ applicationSystem, applyUrl }) {
      if (applicationSystem !== "greenhouse") return null
      const ref = greenhouseJobRef(applyUrl)
      if (!ref) return null
      try {
        const body = greenhouseJobSchema.safeParse(
          await http.getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(ref.token)}/jobs/${ref.jobId}?questions=true`)
        )
        if (!body.success || !body.data.questions) return null
        return parseGreenhouseQuestions(body.data.questions)
      } catch {
        return null
      }
    },
  }
}

function parseGreenhouseQuestions(questions: NonNullable<z.output<typeof greenhouseJobSchema>["questions"]>): SchemaQuestion[] {
  return questions.flatMap((question) => {
    const text = htmlToText(decodeEntities(question.label)).replace(/\s+/g, " ").trim()
    return question.fields
      .filter((item) => item.name.trim() !== "")
      .map((item) => ({ text, fieldName: item.name, ...(item.values ? { options: item.values.map((value) => value.label) } : {}) }))
  })
}

/**
 * Matches each control to a schema field by the control's name or id, never by
 * its rendered label. A schema field matching more than one control, or a
 * control matching more than one field, is left unmatched (its work question
 * then blocks). Any `schemaQuestion` the page side carried is discarded.
 */
export function attachSchema<T extends FormField>(controls: readonly T[], schema: readonly SchemaQuestion[] | null): T[] {
  const bare = controls.map((control) => {
    if (control.schemaQuestion === undefined) return control
    const rest: T = { ...control }
    delete (rest as { schemaQuestion?: SchemaQuestion }).schemaQuestion
    return rest
  })
  if (!schema || schema.length === 0) return bare
  const keys = (control: FormField) => [control.fieldName, control.fieldId].filter((key): key is string => typeof key === "string" && key !== "")
  const matchesOf = (question: SchemaQuestion) => bare.filter((control) => keys(control).includes(question.fieldName))
  return bare.map((control) => {
    const found = schema.filter((question) => keys(control).includes(question.fieldName))
    const only = found.length === 1 ? found[0] : undefined
    if (!only || matchesOf(only).length !== 1) return control
    return { ...control, schemaQuestion: only }
  })
}
