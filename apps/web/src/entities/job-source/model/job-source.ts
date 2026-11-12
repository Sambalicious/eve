/**
 * Job Sources (CONTEXT.md: Job Source): the starter employer list and the
 * remote-job boards. One slice holds both because one endpoint returns both
 * (design-spec FSD map splits them into `job-source` and `employer-list`;
 * frontend report records the merge).
 */
export type RemoteBoardKey = "himalayas" | "remoteok" | "remotive" | "weworkremotely"

export interface EmployerListCompany {
  readonly id: string
  readonly position: number
  readonly company: string
  /** "Greenhouse", "Lever" or "Ashby". */
  readonly applicationSystem: string
  readonly boardUrl: string
  readonly isCrypto: boolean
  readonly note: string | null
}

export interface EmployerList {
  readonly approvedAt: string | null
  readonly companies: readonly EmployerListCompany[]
}

export interface RemoteBoard {
  readonly key: RemoteBoardKey
  readonly name: string
  readonly verification: { readonly on: string; readonly basis: string } | null
  readonly enabled: boolean
  /** Why the board can't be verified or enabled yet (Remotive: written permission); null when it can. */
  readonly unavailableReason: string | null
}

export interface JobSources {
  readonly employerList: EmployerList
  /** In the fixed verification order: Himalayas, Remote OK, Remotive, We Work Remotely. */
  readonly remoteBoards: readonly RemoteBoard[]
  readonly scheduledDiscoveryOn: boolean
}
