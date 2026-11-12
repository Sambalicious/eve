import { type Kysely, sql } from "kysely"

import { recordSchemaMarker } from "./schema-markers.js"

/**
 * EPIC-0002 B1 (api-contract-b1 v1.25.0, developed as v1.24.0, "Owner migration
 * value shape"; architecture.r6 "B1 amendment (threat model F-TM-04): migration
 * 0026"; threat model TM-B1-15). Numbered 0027 after apply anyway bounds' 0026
 * (developed as 0025 after EPIC-0008's 0024, then 0026 after apply anyway's
 * 0025; renumbered at each merge, D19).
 *
 * 1. Rewrite. 0018 stored the Operator's version 1 in a provisional shape. This
 *    builds version 2 in the v1.25.0 shape: `seniorityLevels` becomes all five
 *    levels, the four EPIC-0006 families are added at tier 3 (the built `TIER`),
 *    and `excludedRoleFamilies` is removed. Every other key is byte-equal,
 *    `timeZone` included, so v2 is not a D41 time zone change and no verdict,
 *    rank or count changes.
 * 2. Preflight, on the rewritten value and before any write: exactly the 17
 *    v1.25.0 keys, the 13 catalog tiers with one not excluded, both currencies
 *    in the frozen list, both amounts `^\d{1,9}\.\d{2}$`, the latest work hour
 *    01:00 to 23:59, and `UTC` or a frozen ICU zone name.
 * 3. Fail closed. A refusal throws `owner_preferences_migration_refused: <field>`,
 *    naming the field and never the value. The migrator's transaction rolls
 *    back, so nothing is written and the schema stays at 0026. The Operator
 *    fixes the source row and runs it again. No value is ever coerced.
 * 4. Write. Insert `job_preferences_version` v2, then update `job_preferences`
 *    to v2; v1 stays. FORCE RLS binds this owner role, so `eve.candidate_id` is
 *    set to the Operator and the transaction bound to them (as 0024 does), and
 *    the setting is reset to '' before the marker. Add
 *    `candidate_posting.preferences_version integer not null default 0`: the
 *    column sits on a table that already has its forced `<table>_candidate`
 *    policy, so it needs no policy or grant of its own. Nothing else is
 *    written: no other Candidate, posting status, Application, outbox or spend.
 *
 * Frozen: imports nothing from the app or `@eve/contracts`. The lists below are
 * copies, and a later migration copies a list again when the contract changes.
 */
export const PREFERENCES_VERSION_MARKER = "0027-preferences-version"

/** v1.25.0 `PAY_CURRENCIES`, frozen. A unit test keeps it equal to the contract today. */
export const FROZEN_PAY_CURRENCIES: readonly string[] = Object.freeze([
  "USD", "EUR", "AUD", "BRL", "CAD", "CHF", "CZK", "DKK", "GBP", "ILS",
  "INR", "JPY", "MXN", "NOK", "NZD", "PLN", "SEK", "SGD", "TRY", "ZAR",
])

/** `Intl.supportedValuesOf("timeZone")` on the pinned Node 24 (v24.22.1, ICU tz 2026e), frozen. `UTC` is accepted separately. Not `pg_timezone_names`, which differs from ICU. */
export const FROZEN_TIME_ZONES: readonly string[] = Object.freeze([
  "Africa/Abidjan", "Africa/Accra", "Africa/Addis_Ababa", "Africa/Algiers", "Africa/Asmera", "Africa/Bamako",
  "Africa/Bangui", "Africa/Banjul", "Africa/Bissau", "Africa/Blantyre", "Africa/Brazzaville", "Africa/Bujumbura",
  "Africa/Cairo", "Africa/Casablanca", "Africa/Ceuta", "Africa/Conakry", "Africa/Dakar", "Africa/Dar_es_Salaam",
  "Africa/Djibouti", "Africa/Douala", "Africa/El_Aaiun", "Africa/Freetown", "Africa/Gaborone", "Africa/Harare",
  "Africa/Johannesburg", "Africa/Juba", "Africa/Kampala", "Africa/Khartoum", "Africa/Kigali", "Africa/Kinshasa",
  "Africa/Lagos", "Africa/Libreville", "Africa/Lome", "Africa/Luanda", "Africa/Lubumbashi", "Africa/Lusaka",
  "Africa/Malabo", "Africa/Maputo", "Africa/Maseru", "Africa/Mbabane", "Africa/Mogadishu", "Africa/Monrovia",
  "Africa/Nairobi", "Africa/Ndjamena", "Africa/Niamey", "Africa/Nouakchott", "Africa/Ouagadougou",
  "Africa/Porto-Novo", "Africa/Sao_Tome", "Africa/Tripoli", "Africa/Tunis", "Africa/Windhoek", "America/Adak",
  "America/Anchorage", "America/Anguilla", "America/Antigua", "America/Araguaina", "America/Argentina/La_Rioja",
  "America/Argentina/Rio_Gallegos", "America/Argentina/Salta", "America/Argentina/San_Juan",
  "America/Argentina/San_Luis", "America/Argentina/Tucuman", "America/Argentina/Ushuaia", "America/Aruba",
  "America/Asuncion", "America/Bahia", "America/Bahia_Banderas", "America/Barbados", "America/Belem",
  "America/Belize", "America/Blanc-Sablon", "America/Boa_Vista", "America/Bogota", "America/Boise",
  "America/Buenos_Aires", "America/Cambridge_Bay", "America/Campo_Grande", "America/Cancun", "America/Caracas",
  "America/Catamarca", "America/Cayenne", "America/Cayman", "America/Chicago", "America/Chihuahua",
  "America/Ciudad_Juarez", "America/Coral_Harbour", "America/Cordoba", "America/Costa_Rica", "America/Coyhaique",
  "America/Creston", "America/Cuiaba", "America/Curacao", "America/Danmarkshavn", "America/Dawson",
  "America/Dawson_Creek", "America/Denver", "America/Detroit", "America/Dominica", "America/Edmonton",
  "America/Eirunepe", "America/El_Salvador", "America/Fort_Nelson", "America/Fortaleza", "America/Glace_Bay",
  "America/Godthab", "America/Goose_Bay", "America/Grand_Turk", "America/Grenada", "America/Guadeloupe",
  "America/Guatemala", "America/Guayaquil", "America/Guyana", "America/Halifax", "America/Havana",
  "America/Hermosillo", "America/Indiana/Knox", "America/Indiana/Marengo", "America/Indiana/Petersburg",
  "America/Indiana/Tell_City", "America/Indiana/Vevay", "America/Indiana/Vincennes", "America/Indiana/Winamac",
  "America/Indianapolis", "America/Inuvik", "America/Iqaluit", "America/Jamaica", "America/Jujuy", "America/Juneau",
  "America/Kentucky/Monticello", "America/Kralendijk", "America/La_Paz", "America/Lima", "America/Los_Angeles",
  "America/Louisville", "America/Lower_Princes", "America/Maceio", "America/Managua", "America/Manaus",
  "America/Marigot", "America/Martinique", "America/Matamoros", "America/Mazatlan", "America/Mendoza",
  "America/Menominee", "America/Merida", "America/Metlakatla", "America/Mexico_City", "America/Miquelon",
  "America/Moncton", "America/Monterrey", "America/Montevideo", "America/Montserrat", "America/Nassau",
  "America/New_York", "America/Nome", "America/Noronha", "America/North_Dakota/Beulah",
  "America/North_Dakota/Center", "America/North_Dakota/New_Salem", "America/Ojinaga", "America/Panama",
  "America/Paramaribo", "America/Phoenix", "America/Port-au-Prince", "America/Port_of_Spain", "America/Porto_Velho",
  "America/Puerto_Rico", "America/Punta_Arenas", "America/Rankin_Inlet", "America/Recife", "America/Regina",
  "America/Resolute", "America/Rio_Branco", "America/Santarem", "America/Santiago", "America/Santo_Domingo",
  "America/Sao_Paulo", "America/Scoresbysund", "America/Sitka", "America/St_Barthelemy", "America/St_Johns",
  "America/St_Kitts", "America/St_Lucia", "America/St_Thomas", "America/St_Vincent", "America/Swift_Current",
  "America/Tegucigalpa", "America/Thule", "America/Tijuana", "America/Toronto", "America/Tortola",
  "America/Vancouver", "America/Whitehorse", "America/Winnipeg", "America/Yakutat", "Antarctica/Casey",
  "Antarctica/Davis", "Antarctica/DumontDUrville", "Antarctica/Macquarie", "Antarctica/Mawson", "Antarctica/McMurdo",
  "Antarctica/Palmer", "Antarctica/Rothera", "Antarctica/Syowa", "Antarctica/Troll", "Antarctica/Vostok",
  "Arctic/Longyearbyen", "Asia/Aden", "Asia/Almaty", "Asia/Amman", "Asia/Anadyr", "Asia/Aqtau", "Asia/Aqtobe",
  "Asia/Ashgabat", "Asia/Atyrau", "Asia/Baghdad", "Asia/Bahrain", "Asia/Baku", "Asia/Bangkok", "Asia/Barnaul",
  "Asia/Beirut", "Asia/Bishkek", "Asia/Brunei", "Asia/Calcutta", "Asia/Chita", "Asia/Colombo", "Asia/Damascus",
  "Asia/Dhaka", "Asia/Dili", "Asia/Dubai", "Asia/Dushanbe", "Asia/Famagusta", "Asia/Gaza", "Asia/Hebron",
  "Asia/Hong_Kong", "Asia/Hovd", "Asia/Irkutsk", "Asia/Jakarta", "Asia/Jayapura", "Asia/Jerusalem", "Asia/Kabul",
  "Asia/Kamchatka", "Asia/Karachi", "Asia/Katmandu", "Asia/Khandyga", "Asia/Krasnoyarsk", "Asia/Kuala_Lumpur",
  "Asia/Kuching", "Asia/Kuwait", "Asia/Macau", "Asia/Magadan", "Asia/Makassar", "Asia/Manila", "Asia/Muscat",
  "Asia/Nicosia", "Asia/Novokuznetsk", "Asia/Novosibirsk", "Asia/Omsk", "Asia/Oral", "Asia/Phnom_Penh",
  "Asia/Pontianak", "Asia/Pyongyang", "Asia/Qatar", "Asia/Qostanay", "Asia/Qyzylorda", "Asia/Rangoon", "Asia/Riyadh",
  "Asia/Saigon", "Asia/Sakhalin", "Asia/Samarkand", "Asia/Seoul", "Asia/Shanghai", "Asia/Singapore",
  "Asia/Srednekolymsk", "Asia/Taipei", "Asia/Tashkent", "Asia/Tbilisi", "Asia/Tehran", "Asia/Thimphu", "Asia/Tokyo",
  "Asia/Tomsk", "Asia/Ulaanbaatar", "Asia/Urumqi", "Asia/Ust-Nera", "Asia/Vientiane", "Asia/Vladivostok",
  "Asia/Yakutsk", "Asia/Yekaterinburg", "Asia/Yerevan", "Atlantic/Azores", "Atlantic/Bermuda", "Atlantic/Canary",
  "Atlantic/Cape_Verde", "Atlantic/Faeroe", "Atlantic/Madeira", "Atlantic/Reykjavik", "Atlantic/South_Georgia",
  "Atlantic/St_Helena", "Atlantic/Stanley", "Australia/Adelaide", "Australia/Brisbane", "Australia/Broken_Hill",
  "Australia/Darwin", "Australia/Eucla", "Australia/Hobart", "Australia/Lindeman", "Australia/Lord_Howe",
  "Australia/Melbourne", "Australia/Perth", "Australia/Sydney", "Europe/Amsterdam", "Europe/Andorra",
  "Europe/Astrakhan", "Europe/Athens", "Europe/Belgrade", "Europe/Berlin", "Europe/Bratislava", "Europe/Brussels",
  "Europe/Bucharest", "Europe/Budapest", "Europe/Busingen", "Europe/Chisinau", "Europe/Copenhagen", "Europe/Dublin",
  "Europe/Gibraltar", "Europe/Guernsey", "Europe/Helsinki", "Europe/Isle_of_Man", "Europe/Istanbul", "Europe/Jersey",
  "Europe/Kaliningrad", "Europe/Kiev", "Europe/Kirov", "Europe/Lisbon", "Europe/Ljubljana", "Europe/London",
  "Europe/Luxembourg", "Europe/Madrid", "Europe/Malta", "Europe/Mariehamn", "Europe/Minsk", "Europe/Monaco",
  "Europe/Moscow", "Europe/Oslo", "Europe/Paris", "Europe/Podgorica", "Europe/Prague", "Europe/Riga", "Europe/Rome",
  "Europe/Samara", "Europe/San_Marino", "Europe/Sarajevo", "Europe/Saratov", "Europe/Simferopol", "Europe/Skopje",
  "Europe/Sofia", "Europe/Stockholm", "Europe/Tallinn", "Europe/Tirane", "Europe/Ulyanovsk", "Europe/Vaduz",
  "Europe/Vatican", "Europe/Vienna", "Europe/Vilnius", "Europe/Volgograd", "Europe/Warsaw", "Europe/Zagreb",
  "Europe/Zurich", "Indian/Antananarivo", "Indian/Chagos", "Indian/Christmas", "Indian/Cocos", "Indian/Comoro",
  "Indian/Kerguelen", "Indian/Mahe", "Indian/Maldives", "Indian/Mauritius", "Indian/Mayotte", "Indian/Reunion",
  "Pacific/Apia", "Pacific/Auckland", "Pacific/Bougainville", "Pacific/Chatham", "Pacific/Easter", "Pacific/Efate",
  "Pacific/Enderbury", "Pacific/Fakaofo", "Pacific/Fiji", "Pacific/Funafuti", "Pacific/Galapagos", "Pacific/Gambier",
  "Pacific/Guadalcanal", "Pacific/Guam", "Pacific/Honolulu", "Pacific/Kiritimati", "Pacific/Kosrae",
  "Pacific/Kwajalein", "Pacific/Majuro", "Pacific/Marquesas", "Pacific/Midway", "Pacific/Nauru", "Pacific/Niue",
  "Pacific/Norfolk", "Pacific/Noumea", "Pacific/Pago_Pago", "Pacific/Palau", "Pacific/Pitcairn", "Pacific/Ponape",
  "Pacific/Port_Moresby", "Pacific/Rarotonga", "Pacific/Saipan", "Pacific/Tahiti", "Pacific/Tarawa",
  "Pacific/Tongatapu", "Pacific/Truk", "Pacific/Wake", "Pacific/Wallis"
])

const SENIORITY_LEVELS = ["junior", "mid", "senior", "staff", "principal"]
const ROLE_FAMILIES = [
  "senior_frontend", "technical_lead", "fullstack", "product_engineering", "software_engineering", "backend", "mobile",
  "platform_engineering", "devops_platform", "people_management", "data_ml", "solutions_customer", "other",
]
const VALUE_KEYS = [
  "homeCountry", "timeZone", "latestWorkHour", "workAuthorizedCountries", "remoteAccepted", "relocationAccepted",
  "sponsorshipNeededForRelocation", "excludedRelocationCountries", "excludedIndustries", "payFloor", "preferredPay",
  "roleFamilyTiers", "titleKeyword", "seniorityLevels", "employmentTypes", "dailyCap", "emphasisThemes",
]
/** The four EPIC-0006 families 0018 did not know, at the tier the built ranking gives them. */
const ADDED_TIERS = { software_engineering: 3, platform_engineering: 3, data_ml: 3, solutions_customer: 3 }

type Values = Record<string, unknown>
const isObject = (value: unknown): value is Values => typeof value === "object" && value !== null && !Array.isArray(value)
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join()

/** Step 1: v1 to v2. Pure; returns a new object and leaves `v1` as it is. Exported for its unit test. */
export function rewriteOwnerValues(v1: Values): Values {
  const rest = Object.fromEntries(Object.entries(v1).filter(([key]) => key !== "excludedRoleFamilies"))
  const tiers = isObject(v1.roleFamilyTiers) ? v1.roleFamilyTiers : {}
  return { ...rest, roleFamilyTiers: { ...ADDED_TIERS, ...tiers }, seniorityLevels: [...SENIORITY_LEVELS] }
}

/** Step 2: the first field that fails the preflight, or null. Never returns a value. Exported for its unit test. */
export function ownerPreferencesRefusal(values: Values): string | null {
  if (!sameSet(Object.keys(values), VALUE_KEYS)) return "keys"
  const tiers = values.roleFamilyTiers
  if (
    !isObject(tiers) ||
    !sameSet(Object.keys(tiers), ROLE_FAMILIES) ||
    !Object.values(tiers).every((tier) => tier === 1 || tier === 2 || tier === 3 || tier === "excluded") ||
    !Object.values(tiers).some((tier) => tier !== "excluded")
  ) {
    return "roleFamilyTiers"
  }
  const pays = ["payFloor", "preferredPay"] as const
  for (const pay of pays) {
    const currency = isObject(values[pay]) ? (values[pay] as Values).currency : undefined
    if (typeof currency !== "string" || !FROZEN_PAY_CURRENCIES.includes(currency)) return `${pay}.currency`
  }
  for (const pay of pays) {
    const amount = (values[pay] as Values).amount
    if (typeof amount !== "string" || !/^\d{1,9}\.\d{2}$/.test(amount)) return `${pay}.amount`
  }
  if (typeof values.latestWorkHour !== "string" || !/^(0[1-9]|1\d|2[0-3]):[0-5]\d$/.test(values.latestWorkHour)) return "latestWorkHour"
  if (typeof values.timeZone !== "string" || (values.timeZone !== "UTC" && !FROZEN_TIME_ZONES.includes(values.timeZone))) return "timeZone"
  return null
}

/** Step 3: throws the refusal, naming the field only. */
export function refuseUnlessConforming(values: Values): void {
  const field = ownerPreferencesRefusal(values)
  if (field !== null) throw new Error(`owner_preferences_migration_refused: ${field}`)
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const operators = await sql<{ id: string }>`select id::text as id from candidate where role = 'operator'`.execute(db)
  const operatorId = operators.rows.length === 1 ? operators.rows[0]!.id : null
  if (operatorId !== null) {
    await sql`select set_config('eve.candidate_id', ${operatorId}, true), public.bind_candidate(${operatorId}::uuid)`.execute(db)
    const current = await sql<{ version: number; values: Values }>`select version, "values" from job_preferences where candidate_id = ${operatorId}::uuid`.execute(db)
    const row = current.rows[0]
    if (row !== undefined) {
      const v2 = rewriteOwnerValues(row.values)
      refuseUnlessConforming(v2)
      const next = row.version + 1
      const text = JSON.stringify(v2)
      await sql`insert into job_preferences_version (candidate_id, version, "values") values (${operatorId}::uuid, ${next}, ${text}::jsonb)`.execute(db)
      await sql`update job_preferences set version = ${next}, "values" = ${text}::jsonb, updated_at = now() where candidate_id = ${operatorId}::uuid`.execute(db)
    }
    await sql`select set_config('eve.candidate_id', '', true)`.execute(db)
  }

  await sql`alter table candidate_posting add column preferences_version integer not null default 0`.execute(db)
  await recordSchemaMarker(db, PREFERENCES_VERSION_MARKER)
}

/** Development only: drops the column and the marker. The Operator's version 2 stays: history is immutable. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`delete from migration_marker where name = ${PREFERENCES_VERSION_MARKER}`.execute(db)
  await sql`alter table candidate_posting drop column preferences_version`.execute(db)
}
