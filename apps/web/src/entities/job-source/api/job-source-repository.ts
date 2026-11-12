import {
  EMPLOYER_LIST_APPROVE_PATH,
  JOB_SOURCES_PATH,
  jobSourcesResponseSchema,
  type JobSourcesResponse,
} from "@eve/contracts"

import { apiRequest } from "@/shared/api"
import type { JobSources, RemoteBoardKey } from "../model/job-source"

const SYSTEM_NAME = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" } as const

export async function fetchJobSources(): Promise<JobSources> {
  return toJobSources(await parse(await apiRequest(JOB_SOURCES_PATH)))
}

export async function approveEmployerList(csrfToken: string): Promise<JobSources> {
  return toJobSources(await parse(await apiRequest(EMPLOYER_LIST_APPROVE_PATH, { method: "POST", csrfToken, json: {} })))
}

export async function verifyRemoteBoard(
  key: RemoteBoardKey,
  verification: { verifiedOn: string; basis: string },
  csrfToken: string
): Promise<JobSources> {
  const response = await apiRequest(`${JOB_SOURCES_PATH}/remote-boards/${key}/verification`, {
    method: "PUT",
    csrfToken,
    json: verification,
  })
  return toJobSources(await parse(response))
}

export async function setRemoteBoardEnabled(key: RemoteBoardKey, enabled: boolean, csrfToken: string): Promise<JobSources> {
  const response = await apiRequest(`${JOB_SOURCES_PATH}/remote-boards/${key}/enabled`, {
    method: "PUT",
    csrfToken,
    json: { enabled },
  })
  return toJobSources(await parse(response))
}

async function parse(response: Response): Promise<JobSourcesResponse> {
  return jobSourcesResponseSchema.parse(await response.json())
}

function toJobSources(body: JobSourcesResponse): JobSources {
  return {
    employerList: {
      approvedAt: body.employerList.status === "approved" ? body.employerList.approvedAt : null,
      companies: [...body.employerList.companies]
        .sort((a, b) => a.position - b.position)
        .map((c) => ({
          id: c.id,
          position: c.position,
          company: c.company,
          applicationSystem: SYSTEM_NAME[c.applicationSystem],
          boardUrl: c.boardUrl,
          isCrypto: c.flag === "crypto",
          note: c.note,
        })),
    },
    remoteBoards: [...body.remoteBoards]
      .sort((a, b) => a.order - b.order)
      .map((b) => ({
        key: b.key,
        name: b.name,
        verification: b.verifiedOn && b.verificationBasis ? { on: b.verifiedOn, basis: b.verificationBasis } : null,
        enabled: b.enabled,
        unavailableReason: b.available ? null : (b.unavailableReason ?? ""),
      })),
    scheduledDiscoveryOn: body.scheduledDiscoveryOn,
  }
}
