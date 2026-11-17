import { sql } from "../db/sql.js"

import type { RemoteBoardKey } from "../db/schema.js"
import type { TenantDatabase } from "../db/tenant-database.js"

/**
 * The employer and remote board catalog, split out of `DiscoveryRepository`
 * (which delegates to this class, one instance per facade).
 *
 * Like the facade, every statement runs in the scope's `CandidateTx`; the board
 * tables are shared (item 6 until slices B and C).
 */
export class DiscoveryBoardsRepository {
  constructor(private readonly tenant: TenantDatabase) {}

  readEmployerListState() {
    return this.tenant.run((tx) => tx.selectFrom("employer_list_state").selectAll().executeTakeFirstOrThrow())
  }

  /** Idempotent: the first approval time is kept. */
  async approveEmployerList(at: Date): Promise<void> {
    await this.tenant.run((tx) => tx.updateTable("employer_list_state").set({ approved_at: sql`coalesce(approved_at, ${at})` }).execute())
  }

  listEmployerBoards() {
    return this.tenant.run((tx) => tx.selectFrom("employer_board").selectAll().orderBy("position").execute())
  }

  listRemoteBoards() {
    return this.tenant.run((tx) =>
      tx
        .selectFrom("remote_board")
        .selectAll()
        .select((eb) => eb.cast<string | null>("verified_on", "text").as("verified_on"))
        .orderBy("position")
        .execute()
    )
  }

  findRemoteBoard(key: string) {
    return this.tenant.run((tx) =>
      tx
        .selectFrom("remote_board")
        .selectAll()
        .select((eb) => eb.cast<string | null>("verified_on", "text").as("verified_on"))
        .where("key", "=", key as RemoteBoardKey)
        .executeTakeFirst()
    )
  }

  async verifyRemoteBoard(key: RemoteBoardKey, verifiedOn: string, basis: string): Promise<void> {
    await this.tenant.run((tx) => tx.updateTable("remote_board").set({ verified_on: verifiedOn, verification_basis: basis }).where("key", "=", key).execute())
  }

  async setRemoteBoardEnabled(key: RemoteBoardKey, enabled: boolean): Promise<void> {
    await this.tenant.run((tx) => tx.updateTable("remote_board").set({ enabled }).where("key", "=", key).execute())
  }

  /**
   * Claims today's read of a board: true only if it was not read since `since`
   * (start of today in Africa/Lagos). Enforces "at most once a day per board".
   */
  async claimBoardRead(table: "employer_board" | "remote_board", id: string, since: Date, at: Date): Promise<boolean> {
    const result =
      table === "employer_board"
        ? await this.tenant.run((tx) =>
          tx
              .updateTable("employer_board")
              .set({ last_read_at: at })
              .where("id", "=", id)
              .where((eb) => eb.or([eb("last_read_at", "is", null), eb("last_read_at", "<", since)]))
              .executeTakeFirst()
          )
        : await this.tenant.run((tx) =>
          tx
              .updateTable("remote_board")
              .set({ last_read_at: at })
              .where("key", "=", id as RemoteBoardKey)
              .where((eb) => eb.or([eb("last_read_at", "is", null), eb("last_read_at", "<", since)]))
              .executeTakeFirst()
          )
    return Number(result.numUpdatedRows) > 0
  }
}
