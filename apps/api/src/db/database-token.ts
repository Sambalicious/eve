/** The raw Kysely handle. Candidate code never injects it (ESLint no-restricted-imports); it uses TenantDatabase. */
export const DATABASE = Symbol("DATABASE")
