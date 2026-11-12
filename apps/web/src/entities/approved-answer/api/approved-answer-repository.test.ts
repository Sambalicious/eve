import { http, HttpResponse } from "msw"
import { describe, expect, it } from "vitest"

import { server } from "@/shared/testing"
import { fetchApprovedAnswers, fetchSalaryAnswers } from "./approved-answer-repository"

describe("approved answer repository", () => {
  it("maps the salary response, keeping net pay a different kind from gross figures", async () => {
    server.use(
      http.get("/v1/salary", () =>
        HttpResponse.json({
          grossSalaryPolicy: { amount: 48000, currency: "USD", period: "year", display: "USD 48,000 per year" },
          currentSalary: null,
          preferredNetPay: { amount: 5000, currency: "USD", period: "month_net", display: "USD 5,000 per month net" },
        })
      )
    )

    const salary = await fetchSalaryAnswers()

    expect(salary.grossSalaryPolicy).toEqual({
      kind: "gross",
      amount: 48000,
      currency: "USD",
      period: "year",
      display: "USD 48,000 per year",
    })
    expect(salary.preferredNetPay?.kind).toBe("net")
    expect(salary.preferredNetPay?.period).toBe("month_net")
  })

  it("refuses a response where net pay is shaped as a gross figure", async () => {
    server.use(
      http.get("/v1/salary", () =>
        HttpResponse.json({
          grossSalaryPolicy: { amount: 5000, currency: "USD", period: "month_net", display: "USD 5,000 per month net" },
          currentSalary: null,
          preferredNetPay: null,
        })
      )
    )

    await expect(fetchSalaryAnswers()).rejects.toThrow()
  })

  it("maps each answer group", async () => {
    server.use(
      http.get("/v1/approved-answers", () =>
        HttpResponse.json({
          answers: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              group: "standard",
              topic: "skill_years",
              skill: "React",
              value: "7",
              updatedAt: "2026-10-17T09:00:00.000Z",
            },
            {
              id: "22222222-2222-4222-8222-222222222222",
              group: "custom",
              question: "Why Acme?",
              value: "Payments",
              updatedAt: "2026-10-17T09:00:00.000Z",
            },
          ],
        })
      )
    )

    expect(await fetchApprovedAnswers()).toEqual([
      expect.objectContaining({ group: "standard", topic: "skill_years", skill: "React" }),
      expect.objectContaining({ group: "custom", question: "Why Acme?" }),
    ])
  })
})
