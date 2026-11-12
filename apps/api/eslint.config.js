import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import { defineConfig, globalIgnores } from "eslint/config"

import { globSync } from "node:fs"

import { tenantRules } from "./eslint.tenant-rules.js"

/** Every src file outside src/db and the specs, read when the config loads. */
const TYPED_SRC_FILES = globSync("src/**/*.ts", { cwd: import.meta.dirname }).filter((file) => !file.startsWith("src/db/") && !file.endsWith(".spec.ts"))

/**
 * Architecture r2, Tenancy mechanism 3: Candidate code reaches Postgres only
 * through `TenantDatabase` / `CandidateTx`. The raw `DATABASE` handle is for
 * `db/`, auth, the Operator and system modules, shared-data code and
 * `BrowserMutex` (advisory lock only).
 *
 * LEGACY_RAW_DATABASE lists the classes still on the raw handle. Each A1 unit 2
 * commit removes its module group from this list; the list must be empty
 * before RLS is enabled (migration 0017).
 */
const RAW_DATABASE_ALLOWED = [
  "src/db/**",
  "src/auth/**",
  "src/health/**",
  "src/submission/browser-mutex.ts",
]

const LEGACY_RAW_DATABASE = [
]

const RAW_DATABASE_PATTERNS = ["**/db/database.module.js", "**/db/database-token.js", "**/db/create-database.js"]
const RAW_DATABASE_RULE = {
  group: RAW_DATABASE_PATTERNS,
  message: "Candidate code must not use the raw database. Inject TenantDatabase and use a CandidateTx (architecture r2, Tenancy mechanism 3).",
}

/**
 * EPIC-0002 A2 (architecture r1/r4 Worker job scoping): pg-boss is the shared
 * queue. Only JobQueue and CandidateJobRunner hold it, the api's send-only
 * clients write into it inside the caller's transaction (the sample client on
 * approval; EPIC-0006's evaluation client on Check again, always with the
 * scope Candidate's ID, which the worker's CandidateJobRunner checks), and db/
 * installs its schema. Everything else sends through JobQueue.sendShared /
 * sendForCandidate, and only CandidateJobRunner registers a Candidate handler
 * (pg-boss is a #private field on JobQueue; see LOADER_SYNTAX and CLAIM_SYNTAX).
 */
const PG_BOSS_ALLOWED = ["src/db/**", "src/worker/job-queue.ts", "src/worker/candidate-job-runner.ts", "src/submission/sample-submission-queue.ts", "src/discovery/evaluation-queue.ts"]
const PG_BOSS_PATH = {
  name: "pg-boss",
  message: "Candidate code must not use the shared queue directly. Send through JobQueue.sendShared or sendForCandidate; register Candidate handlers with CandidateJobRunner.work (EPIC-0002 A2).",
}
const RAW_BOSS_ALLOWED = ["src/worker/job-queue.ts", "src/worker/candidate-job-runner.ts"]
const RAW_BOSS_MESSAGE = "Only JobQueue and CandidateJobRunner use pg-boss directly; register Candidate handlers with CandidateJobRunner.work (EPIC-0002 A2)."
/** Kept as a belt to the #private field (F-SEC-02): the old public name stays refused in every spelling lint can see. */
const RAW_BOSS_SYNTAX = [
  { selector: "MemberExpression[property.name='rawBoss']", message: RAW_BOSS_MESSAGE },
  { selector: "ObjectPattern > Property[key.name='rawBoss']", message: RAW_BOSS_MESSAGE },
  { selector: "ObjectPattern > Property[key.value='rawBoss']", message: RAW_BOSS_MESSAGE },
  { selector: "MemberExpression[computed=true][property.value='rawBoss']", message: RAW_BOSS_MESSAGE },
  { selector: "MemberExpression[computed=true][property.quasis.0.value.cooked='rawBoss']", message: RAW_BOSS_MESSAGE },
]

/**
 * F-SEC-02: a dynamic import() escapes no-restricted-imports (pg-boss, the raw
 * database), and a computed source cannot be checked at all. src/ has no
 * dynamic import, so every one is refused outside src/db and the specs.
 */
const DYNAMIC_IMPORT_SYNTAX = [
  {
    selector: "ImportExpression",
    message: "Use a static import: a dynamic import() bypasses the raw database and shared queue rules (EPIC-0002 A2).",
  },
]

/**
 * F-SEC-02 recheck: `createRequire`, `require` and `process.getBuiltinModule`
 * load pg-boss or the raw database without an import statement, so the static
 * import rules never see them. src/ needs no module loader outside src/db.
 * `rawBoss` is gone: pg-boss is a #private field on JobQueue, which closes
 * `Reflect.get` and variable-key access structurally.
 */
const LOADER_MESSAGE = "A module loader (node:module, require, process.getBuiltinModule) bypasses the raw database and shared queue rules. Use a static import (EPIC-0002 A2)."
const MODULE_SOURCE = "/^(node:)?module(\\/.*)?$/"
const LOADER_SYNTAX = [
  { selector: `ImportDeclaration[source.value=${MODULE_SOURCE}]`, message: LOADER_MESSAGE },
  { selector: `ExportNamedDeclaration[source.value=${MODULE_SOURCE}]`, message: LOADER_MESSAGE },
  { selector: `ExportAllDeclaration[source.value=${MODULE_SOURCE}]`, message: LOADER_MESSAGE },
  { selector: `TSImportType[argument.literal.value=${MODULE_SOURCE}]`, message: LOADER_MESSAGE },
  // Spelled differently from ADR 0012's require selector: no-restricted-syntax keys by selector, so an equal one would replace its message.
  { selector: "CallExpression[callee.type='Identifier'][callee.name='require']", message: LOADER_MESSAGE },
  { selector: "MemberExpression[property.name=/^(createRequire|getBuiltinModule)$/]", message: LOADER_MESSAGE },
  { selector: "MemberExpression[computed=true][property.value=/^(createRequire|getBuiltinModule)$/]", message: LOADER_MESSAGE },
]
/** Only candidate-job-runner.ts claims the Candidate handler registration (job-queue.ts, claimCandidateWorker). */
const CLAIM_MESSAGE = "Only CandidateJobRunner claims the Candidate worker registration; register Candidate handlers with CandidateJobRunner.work (EPIC-0002 A2)."
const CLAIM_SYNTAX = [
  { selector: "ImportSpecifier[imported.name='claimCandidateWorker']", message: CLAIM_MESSAGE },
  { selector: "ExportSpecifier[local.name='claimCandidateWorker']", message: CLAIM_MESSAGE },
  { selector: "MemberExpression[property.name='claimCandidateWorker']", message: CLAIM_MESSAGE },
  { selector: "MemberExpression[computed=true][property.value='claimCandidateWorker']", message: CLAIM_MESSAGE },
]

/**
 * F-SEC-02 round 2 and F-SEC-07: string execution reaches pg-boss and the raw
 * database the way a module loader does (`new Function("return import('pg-boss')")`),
 * and a computed key on a global object reaches a loader whose name lint cannot
 * read (`process["getBuiltin" + "Module"]`). src/ needs neither, so in every
 * src file, including src/db, lint refuses: eval, implied eval and the Function
 * constructor (core rules, plus `Function` as a value and the `.constructor`
 * route to AsyncFunction); node:vm; `import x = require()`; a dynamic import()
 * whose source is not a string literal; and any computed member access on, cast
 * of, alias of, spread of, or call argument of `process`, `globalThis`,
 * `global` or `module`. Dot access (`process.env`) stays allowed.
 */
const STRING_EXECUTION_MESSAGE = "String execution (eval, Function, node:vm) can load the shared queue or the raw database past every import rule. src/ needs none (F-SEC-02, EPIC-0002 A2)."
const VM_SOURCE = "/^(node:)?vm$/"
const FUNCTION_CONSTRUCTOR = "/^(Async|Generator|AsyncGenerator)?Function$/"
/**
 * F-SEC-09: `Reflect`, prototypes and property descriptors respell every
 * member rule (`Reflect.get(globalThis.process, "getBuiltin" + "Module")`,
 * `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(async function () {}), ...)`).
 * src/ uses none of them, so they are refused on any object.
 */
const REFLECTION_MESSAGE = "Reflect, prototypes, property descriptors and keys lint cannot read respell the loader and string-execution rules. src/ needs none (F-SEC-09, EPIC-0002 A2)."
const REFLECTION_MEMBER = "/^(getPrototypeOf|setPrototypeOf|getOwnPropertyDescriptors?|getOwnPropertyNames|getOwnPropertySymbols|defineProperty|defineProperties|__proto__|__lookupGetter__|__lookupSetter__|__defineGetter__|__defineSetter__)$/"
const STRING_EXECUTION_SYNTAX = [
  { selector: `ImportDeclaration[source.value=${VM_SOURCE}]`, message: STRING_EXECUTION_MESSAGE },
  { selector: `ExportNamedDeclaration[source.value=${VM_SOURCE}]`, message: STRING_EXECUTION_MESSAGE },
  { selector: `ExportAllDeclaration[source.value=${VM_SOURCE}]`, message: STRING_EXECUTION_MESSAGE },
  { selector: `TSImportType[argument.literal.value=${VM_SOURCE}]`, message: STRING_EXECUTION_MESSAGE },
  { selector: "TSImportEqualsDeclaration[moduleReference.type='TSExternalModuleReference']", message: LOADER_MESSAGE },
  { selector: "ImportExpression:not([source.type='Literal'])", message: "A dynamic import() source must be a string literal (F-SEC-02, EPIC-0002 A2)." },
  // The AsyncFunction / GeneratorFunction constructors run strings too. `error.constructor.name` stays allowed.
  { selector: "MemberExpression[property.name='constructor']:not(MemberExpression[property.name='name'] > MemberExpression.object)", message: STRING_EXECUTION_MESSAGE },
  { selector: "MemberExpression[computed=true][property.value='constructor']", message: STRING_EXECUTION_MESSAGE },
  { selector: "ObjectPattern > Property[key.name='constructor']", message: STRING_EXECUTION_MESSAGE },
  { selector: "ObjectPattern > Property[key.value='constructor']", message: STRING_EXECUTION_MESSAGE },
  // F-SEC-09: a member route to a string-running constructor (`globalThis.Function`, `global.Function`, `lib.AsyncFunction`).
  { selector: `MemberExpression[property.name=${FUNCTION_CONSTRUCTOR}]`, message: STRING_EXECUTION_MESSAGE },
  { selector: `MemberExpression[computed=true][property.value=${FUNCTION_CONSTRUCTOR}]`, message: STRING_EXECUTION_MESSAGE },
  { selector: `ObjectPattern > Property[key.name=${FUNCTION_CONSTRUCTOR}]`, message: STRING_EXECUTION_MESSAGE },
  { selector: `ObjectPattern > Property[key.value=${FUNCTION_CONSTRUCTOR}]`, message: STRING_EXECUTION_MESSAGE },
  // F-SEC-09: the prototype and descriptor routes to a constructor, in any spelling lint can see.
  { selector: `MemberExpression[property.name=${REFLECTION_MEMBER}]`, message: REFLECTION_MESSAGE },
  { selector: `MemberExpression[computed=true][property.value=${REFLECTION_MEMBER}]`, message: REFLECTION_MESSAGE },
  { selector: "MemberExpression[property.name='Reflect']", message: REFLECTION_MESSAGE },
  // F-SEC-09: a key lint cannot read (`fn["constru" + "ctor"]`, a template with a hole, a computed destructuring key, any computed key on a function literal).
  { selector: "MemberExpression[computed=true] > BinaryExpression.property:has(Literal[raw=/^[\"']/])", message: REFLECTION_MESSAGE },
  { selector: "MemberExpression[computed=true] > TemplateLiteral.property[expressions.length>0]", message: REFLECTION_MESSAGE },
  { selector: "ObjectPattern > Property[computed=true]", message: REFLECTION_MESSAGE },
  { selector: "MemberExpression[computed=true][object.name=/^(Object|Function|Reflect|Symbol|Proxy)$/]", message: REFLECTION_MESSAGE },
  { selector: ":matches(TSAsExpression, TSSatisfiesExpression, TSTypeAssertion, TSNonNullExpression) > Identifier.expression[name=/^(Object|Proxy)$/]", message: REFLECTION_MESSAGE },
  { selector: ":matches(VariableDeclarator > Identifier.init, AssignmentExpression > Identifier.right, AssignmentPattern > Identifier.right, SpreadElement > Identifier.argument)[name=/^(Object|Proxy)$/]", message: REFLECTION_MESSAGE },
  { selector: "MemberExpression[computed=true][object.type=/^(ArrowFunctionExpression|FunctionExpression|ClassExpression)$/]", message: REFLECTION_MESSAGE },
]
const STRING_EXECUTION_GLOBALS = [...["eval", "Function"].map((name) => ({ name, message: STRING_EXECUTION_MESSAGE })), { name: "Reflect", message: REFLECTION_MESSAGE }]
const STRING_EXECUTION_RULES = { "no-eval": "error", "no-implied-eval": "error", "no-new-func": "error" }

const GLOBAL_KEY_MESSAGE = "Reach process, globalThis, global and module by dot access only: a computed key, cast, alias or spread hides a module loader from lint (F-SEC-07, EPIC-0002 A2)."
const GLOBAL_HANDLE = "/^(process|globalThis|global|module)$/"
const GLOBAL_KEY_SYNTAX = [
  { selector: `MemberExpression[computed=true][object.name=${GLOBAL_HANDLE}]`, message: GLOBAL_KEY_MESSAGE },
  { selector: "MemberExpression[computed=true][object.type='MemberExpression'][object.property.name=/^(process|globalThis|global)$/]", message: GLOBAL_KEY_MESSAGE },
  { selector: `:matches(TSAsExpression, TSSatisfiesExpression, TSTypeAssertion, TSNonNullExpression) > Identifier.expression[name=${GLOBAL_HANDLE}]`, message: GLOBAL_KEY_MESSAGE },
  { selector: `VariableDeclarator > Identifier.init[name=${GLOBAL_HANDLE}]`, message: GLOBAL_KEY_MESSAGE },
  { selector: `AssignmentExpression > Identifier.right[name=${GLOBAL_HANDLE}]`, message: GLOBAL_KEY_MESSAGE },
  { selector: `AssignmentPattern > Identifier.right[name=${GLOBAL_HANDLE}]`, message: GLOBAL_KEY_MESSAGE },
  { selector: `:matches(CallExpression, NewExpression) > Identifier.arguments[name=${GLOBAL_HANDLE}]`, message: GLOBAL_KEY_MESSAGE },
  { selector: `SpreadElement > Identifier.argument[name=${GLOBAL_HANDLE}]`, message: GLOBAL_KEY_MESSAGE },
]

/**
 * F-SEC-07 import boundary: only candidate-job-runner.ts may take
 * `claimCandidateWorker`, so every other way to get a binding to it is refused
 * outside that file: a named import under any name or string name, a namespace
 * import of job-queue (which would allow destructuring, `Reflect.get`, computed
 * keys or `Object.values`), `export *` from it, a string-named re-export, and a
 * dynamic import of it.
 */
const JOB_QUEUE_SOURCE = "/(^|\\/)job-queue(\\.js)?$/"
const CLAIM_BOUNDARY_SYNTAX = [
  { selector: "ImportSpecifier[imported.value='claimCandidateWorker']", message: CLAIM_MESSAGE },
  { selector: "ExportSpecifier[local.value='claimCandidateWorker']", message: CLAIM_MESSAGE },
  { selector: `ImportDeclaration[source.value=${JOB_QUEUE_SOURCE}] > ImportNamespaceSpecifier`, message: CLAIM_MESSAGE },
  { selector: `ExportAllDeclaration[source.value=${JOB_QUEUE_SOURCE}]`, message: CLAIM_MESSAGE },
  { selector: `ImportExpression[source.value=${JOB_QUEUE_SOURCE}]`, message: CLAIM_MESSAGE },
]
/**
 * Residuals lint cannot close, accepted in writing (ADR 0012 calls these rules
 * defence in depth, not a sandbox): `node:child_process` and
 * `node:worker_threads` (resume-text.ts spawns a child) can start a second
 * Node process that loads anything, and `import pg from "pg"` is allowed
 * (api-exception.filter.ts). Neither reaches Candidate rows or the claim: the
 * runtime role has no `eve.candidate_id` outside a scope, so RLS returns no
 * Candidate row; pg-boss in this process is a #private field no property access
 * returns; and claimCandidateWorker is one-shot, claimed when the runner module
 * loads, so an earlier thief stops the worker from booting.
 *
 * F-SEC-09 residual: a value reached through a variable key on an object lint
 * cannot name (a parameter `o[k]` where a caller passed `Object` or a function
 * from another file) is cross-file aliasing, the written review item ADR 0012
 * already accepts. Harmless for the same reasons: a Function built that way
 * still cannot read the #private pg-boss field or retake the one-shot claim,
 * and a raw connection it opens has no `eve.candidate_id`, so RLS shows it no
 * Candidate row; the key itself cannot be named outside src/db.
 */
/**
 * F-SEC-09: RLS keys on `eve.candidate_id` (and `eve.scope`), which only
 * TenantDatabase sets. Outside src/db, no string may name the key or
 * `set_config`, so a repository cannot point its transaction at another
 * Candidate.
 */
const TENANT_KEY_MESSAGE = "Only TenantDatabase (src/db) sets the RLS key: no set_config, eve.candidate_id or eve.scope outside src/db (F-SEC-09, EPIC-0002 A2)."
const TENANT_KEY_PATTERN = "/set_config|eve\\.(candidate_id|scope)/i"
const TENANT_KEY_SYNTAX = [
  { selector: `Literal[value=${TENANT_KEY_PATTERN}]`, message: TENANT_KEY_MESSAGE },
  { selector: `TemplateElement[value.raw=${TENANT_KEY_PATTERN}]`, message: TENANT_KEY_MESSAGE },
]

/** Every src file except the claimant and specs. */
const HARDENING_SYNTAX = [...STRING_EXECUTION_SYNTAX, ...GLOBAL_KEY_SYNTAX, ...CLAIM_BOUNDARY_SYNTAX]

/**
 * C36 (architecture r4 Tenancy 2a): only the access-request module, the sender's
 * installation outbox (access-request rendering and status counts) and the
 * access-request retention jobs open the installation scope.
 */
const INSTALLATION_SCOPE_ALLOWED = ["src/db/**", "src/access-request/**", "src/notification/access-request-outbox.repository.ts", "src/worker/access-request-jobs.ts"]
const INSTALLATION_SCOPE_SYNTAX = [
  {
    selector: "MemberExpression[property.name='forInstallation']",
    message: "Only the access-request module, its sender outbox and its retention jobs may open the installation scope (C36, architecture r4 Tenancy 2a).",
  },
]
/**
 * ADR 0012 (SEC-E5-02, SEC-E5-07, SEC-E5F-01, CR-E5F-04): only `alert-feed-http.ts` may make network
 * requests in the Stack posts module. The ADR lists this target rule set and states that it is
 * defence in depth, not a sandbox: aliasing it cannot see stays a code review item.
 */
const ADR_0012 = "ADR 0012: only src/stack-posts/alert-feed-http.ts may make HTTP requests in the Stack posts module."
const NETWORK_MODULES = ["undici", "http", "https", "http2", "net", "tls", "dns", "dgram", "child_process", "worker_threads", "module"]
const LIBRARY_MODULES = ["axios", "got", "node-fetch"]
const HTTP_MODULES = [...NETWORK_MODULES.flatMap((name) => [name, `node:${name}`]), ...LIBRARY_MODULES]
/** Subpaths (`undici/lib/fetch`, `dns/promises`) and other modules' HTTP clients. The module's own client stays importable as `./`. */
const HTTP_MODULE_PATTERNS = [...HTTP_MODULES.map((name) => `${name}/*`), "**/sources/board-http*", "**/alert-feed-http*", "!./alert-feed-http.js", "!./alert-feed-http.provider.js"]
/** Any path that reaches into `node_modules`, relative or not. */
const NODE_MODULES_PATH = "node_modules"
const GLOBAL_OBJECTS = ["globalThis", "global", "window", "self"]
const GLOBAL_OBJECT_NAME = `/^(${GLOBAL_OBJECTS.join("|")})$/`
/**
 * Dynamic `import()` (SEC-E5-07): only a plain string literal starting with "./" or "../" and not
 * containing `node_modules`. `require`, `Reflect.get`/`apply`/`construct`, and any variable,
 * parameter default or assignment taken from a global object (`const g = globalThis`, including
 * destructuring) are refused (SEC-E5F-01).
 */
const RESTRICTED_SYNTAX = [
  { selector: "ImportExpression:not([source.type='Literal'][source.value=/^\\.{1,2}\\//])", message: ADR_0012 },
  { selector: `ImportExpression[source.value=/${NODE_MODULES_PATH}/]`, message: ADR_0012 },
  { selector: "CallExpression[callee.name='require']", message: ADR_0012 },
  { selector: "MemberExpression[object.name='Reflect'][property.name=/^(get|apply|construct)$/]", message: ADR_0012 },
  { selector: `VariableDeclarator[init.type='Identifier'][init.name=${GLOBAL_OBJECT_NAME}]`, message: ADR_0012 },
  { selector: `AssignmentPattern[right.type='Identifier'][right.name=${GLOBAL_OBJECT_NAME}]`, message: ADR_0012 },
  { selector: `AssignmentExpression[right.type='Identifier'][right.name=${GLOBAL_OBJECT_NAME}]`, message: ADR_0012 },
]
const RESTRICTED_PROPERTIES = [
  ...GLOBAL_OBJECTS.map((object) => ({ object, property: "fetch", message: ADR_0012 })),
  ...["getBuiltinModule", "binding", "dlopen"].map((property) => ({ object: "process", property, message: ADR_0012 })),
]

export default defineConfig([
  globalIgnores(["dist"]),
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, globals: globals.node },
  },
  {
    // Raw database and shared queue imports. Files allowed one but not the other get their own block below.
    files: ["src/**/*.ts"],
    ignores: [...RAW_DATABASE_ALLOWED, ...LEGACY_RAW_DATABASE, ...PG_BOSS_ALLOWED, "src/**/*.spec.ts", "src/main.*.ts", "src/app.module.ts", "src/worker/worker.module.ts"],
    rules: { "no-restricted-imports": ["error", { paths: [PG_BOSS_PATH], patterns: [RAW_DATABASE_RULE] }] },
  },
  {
    // PG_BOSS_ALLOWED files outside RAW_DATABASE_ALLOWED: the raw database rule only.
    files: PG_BOSS_ALLOWED.filter((file) => !file.startsWith("src/db/")),
    rules: { "no-restricted-imports": ["error", { patterns: [RAW_DATABASE_RULE] }] },
  },
  {
    // RAW_DATABASE_ALLOWED files outside PG_BOSS_ALLOWED: the shared queue rule only.
    files: RAW_DATABASE_ALLOWED.filter((file) => !file.startsWith("src/db/")),
    ignores: ["src/**/*.spec.ts"],
    rules: { "no-restricted-imports": ["error", { paths: [PG_BOSS_PATH] }] },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [...INSTALLATION_SCOPE_ALLOWED, ...RAW_BOSS_ALLOWED, "src/**/*.spec.ts"],
    rules: { "no-restricted-syntax": ["error", ...INSTALLATION_SCOPE_SYNTAX, ...RAW_BOSS_SYNTAX, ...DYNAMIC_IMPORT_SYNTAX, ...LOADER_SYNTAX, ...CLAIM_SYNTAX, ...HARDENING_SYNTAX, ...TENANT_KEY_SYNTAX] },
  },
  {
    // ESLint flat config replaces a rule per file: the installation-scope allow list keeps the queue rules.
    files: INSTALLATION_SCOPE_ALLOWED.filter((file) => !file.startsWith("src/db/")),
    ignores: [...RAW_BOSS_ALLOWED, "src/**/*.spec.ts"],
    rules: { "no-restricted-syntax": ["error", ...RAW_BOSS_SYNTAX, ...DYNAMIC_IMPORT_SYNTAX, ...LOADER_SYNTAX, ...CLAIM_SYNTAX, ...HARDENING_SYNTAX, ...TENANT_KEY_SYNTAX] },
  },
  {
    files: ["src/worker/job-queue.ts"],
    rules: { "no-restricted-syntax": ["error", ...INSTALLATION_SCOPE_SYNTAX, ...DYNAMIC_IMPORT_SYNTAX, ...LOADER_SYNTAX, ...CLAIM_SYNTAX, ...HARDENING_SYNTAX, ...TENANT_KEY_SYNTAX] },
  },
  {
    // The one claimant of the Candidate worker registration.
    files: ["src/worker/candidate-job-runner.ts"],
    rules: { "no-restricted-syntax": ["error", ...INSTALLATION_SCOPE_SYNTAX, ...DYNAMIC_IMPORT_SYNTAX, ...LOADER_SYNTAX, ...STRING_EXECUTION_SYNTAX, ...GLOBAL_KEY_SYNTAX, ...TENANT_KEY_SYNTAX] },
  },
  {
    // src/db may load modules (migrations, the pg-boss schema) but runs no strings, reads no global by computed key and takes no claim.
    files: ["src/db/**/*.ts"],
    ignores: ["src/**/*.spec.ts"],
    rules: { "no-restricted-syntax": ["error", ...CLAIM_SYNTAX, ...HARDENING_SYNTAX] },
  },
  {
    // String execution: every src file outside specs. The stack-posts block below repeats Function next to its ADR 0012 globals.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.spec.ts"],
    rules: { ...STRING_EXECUTION_RULES, "no-restricted-globals": ["error", ...STRING_EXECUTION_GLOBALS] },
  },
  {
    // Repair wave 2: Kysely's raw-SQL helpers and executor routes only in src/db (eslint.tenant-rules.js).
    files: ["src/**/*.ts"],
    ignores: ["src/db/**", "src/**/*.spec.ts"],
    plugins: { tenant: tenantRules },
    rules: { "tenant/no-raw-sql": "error" },
  },
  {
    // Repair wave 2: the type-aware module boundary rule, on every src file on disk outside src/db.
    // Lint probes (*-lint.spec.ts) lint text as src paths that may not exist; the project service
    // cannot type those, so they get the rules above only.
    files: TYPED_SRC_FILES,
    plugins: { tenant: tenantRules },
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: { "tenant/no-computed-function-member": "error" },
  },
  {
    // ESLint flat config replaces a rule per file, so this block repeats the
    // raw-database patterns next to the ADR 0012 paths, and the installation-scope
    // syntax next to the ADR 0012 syntax.
    files: ["src/stack-posts/**/*.ts"],
    ignores: ["src/stack-posts/alert-feed-http.ts", "src/stack-posts/**/*.spec.ts"],
    rules: {
      "no-restricted-globals": ["error", ...["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "eval"].map((name) => ({ name, message: ADR_0012 })), { name: "Function", message: STRING_EXECUTION_MESSAGE }, { name: "Reflect", message: REFLECTION_MESSAGE }],
      "no-restricted-properties": ["error", ...RESTRICTED_PROPERTIES],
      "no-restricted-imports": [
        "error",
        {
          paths: [...HTTP_MODULES.map((name) => ({ name, message: ADR_0012 })), PG_BOSS_PATH],
          patterns: [
            { group: HTTP_MODULE_PATTERNS, message: ADR_0012 },
            RAW_DATABASE_RULE,
            { regex: NODE_MODULES_PATH, message: ADR_0012 },
          ],
        },
      ],
      "no-restricted-syntax": ["error", ...RESTRICTED_SYNTAX, ...INSTALLATION_SCOPE_SYNTAX, ...RAW_BOSS_SYNTAX, ...DYNAMIC_IMPORT_SYNTAX, ...LOADER_SYNTAX, ...CLAIM_SYNTAX, ...HARDENING_SYNTAX, ...TENANT_KEY_SYNTAX],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  // A live, manual check against a real provider. It is outside the api surface, and its `any`
  // usage against provider responses added 20 errors to every gate report in EPIC-0014.
  {
    files: ["scripts/live-check/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
])
