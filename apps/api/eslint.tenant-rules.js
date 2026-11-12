/**
 * Repair wave 2 (EPIC-0002 A2): local lint rules for src outside src/db.
 * Separate rule names from no-restricted-imports / no-restricted-syntax, so the
 * per-file blocks in eslint.config.js cannot replace them.
 */

const RAW_SQL_MESSAGE = "Kysely's raw-SQL helpers are for src/db only. Import `sql` from src/db/sql.js, which refuses the tenant scope (repair wave 2, EPIC-0002 A2)."
const EXECUTOR_MESSAGE = "Executor, plugin and raw-function access on a Kysely handle is for src/db only: it skips TenantDatabase's scope check (repair wave 2, EPIC-0002 A2)."
/** Kysely value exports that build or run raw SQL. */
const RAW_SQL_EXPORTS = new Set(["sql", "CompiledQuery", "RawNode", "createRawBuilder", "DefaultQueryExecutor", "SingleConnectionProvider", "DefaultConnectionProvider", "NoopQueryExecutor"])
/** Members that reach the executor or drop TenantDatabase's plugin. */
const EXECUTOR_MEMBERS = new Set(["getExecutor", "executeQuery", "withoutPlugins", "withPlugin", "withPlugins", "withPluginAtFront", "withConnectionProvider", "provideConnection", "streamQuery", "stream"])
// `stream` too: inside a transaction it holds the one connection while the scope check needs it.
const isKysely = (source) => source === "kysely" || source.startsWith("kysely/")

function keyName(node) {
  if (!node.computed) return node.property.type === "Identifier" || node.property.type === "PrivateIdentifier" ? node.property.name : undefined
  if (node.property.type === "Literal") return String(node.property.value)
  if (node.property.type === "TemplateLiteral" && node.property.expressions.length === 0) return node.property.quasis[0].value.cooked
  return undefined
}

const noRawSql = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const checkSpecifiers = (node, specifiers) => {
      if (!node.source || !isKysely(String(node.source.value))) return
      if (node.importKind === "type" || node.exportKind === "type") return
      for (const specifier of specifiers) {
        if (specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier") return context.report({ node: specifier, message: RAW_SQL_MESSAGE })
        if (specifier.importKind === "type" || specifier.exportKind === "type") continue
        const imported = specifier.type === "ImportSpecifier" ? specifier.imported : specifier.local
        const name = imported.type === "Identifier" ? imported.name : String(imported.value)
        if (RAW_SQL_EXPORTS.has(name)) context.report({ node: specifier, message: RAW_SQL_MESSAGE })
      }
    }
    return {
      ImportDeclaration: (node) => checkSpecifiers(node, node.specifiers),
      ExportNamedDeclaration: (node) => checkSpecifiers(node, node.specifiers),
      ExportAllDeclaration(node) {
        if (isKysely(String(node.source.value)) && node.exportKind !== "type") context.report({ node, message: RAW_SQL_MESSAGE })
      },
      ImportExpression(node) {
        if (node.source.type === "Literal" && isKysely(String(node.source.value))) context.report({ node, message: RAW_SQL_MESSAGE })
      },
      TSImportEqualsDeclaration(node) {
        const ref = node.moduleReference
        if (ref.type === "TSExternalModuleReference" && isKysely(String(ref.expression.value))) context.report({ node, message: RAW_SQL_MESSAGE })
      },
      MemberExpression(node) {
        const name = keyName(node)
        if (name !== undefined && EXECUTOR_MEMBERS.has(name)) context.report({ node, message: EXECUTOR_MESSAGE })
        // `eb.fn("any_function", ...)` and `fn.agg(...)` call a function by name; `eb.fn.coalesce(...)` stays allowed.
        if (name === "agg" && node.object.type === "MemberExpression" && keyName(node.object) === "fn") context.report({ node, message: EXECUTOR_MESSAGE })
        if (name === "fn" && node.parent.type === "CallExpression" && node.parent.callee === node) context.report({ node, message: EXECUTOR_MESSAGE })
      },
      "VariableDeclarator > ObjectPattern > Property"(node) {
        const name = node.computed ? undefined : node.key.type === "Identifier" ? node.key.name : String(node.key.value)
        if (name !== undefined && (EXECUTOR_MEMBERS.has(name) || name === "fn")) context.report({ node, message: EXECUTOR_MESSAGE })
      },
    }
  },
}

export const tenantRules = { rules: { "no-raw-sql": noRawSql } }

const FUNCTION_MEMBER_MESSAGE = "A computed key on a function or class value can reach its constructor, prototype or statics past every member rule. Use dot access or a literal key (repair wave 2, EPIC-0002 A2)."
const FUNCTION_TYPES = new Set(["Function", "CallableFunction", "NewableFunction"])

/** True when `type` (or any union/intersection member) is callable, constructible or a Function type; `any` counts, since it may be one. */
function isFunctionLike(type, seen = new Set()) {
  if (seen.has(type)) return false
  seen.add(type)
  if (type.flags & 1 /* Any */) return true
  if (type.isUnionOrIntersection?.()) return type.types.some((part) => isFunctionLike(part, seen))
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return true
  const name = type.getSymbol?.()?.getName()
  return name !== undefined && FUNCTION_TYPES.has(name)
}

const isLiteralKey = (property) => property.type === "Literal" || (property.type === "TemplateLiteral" && property.expressions.length === 0)

/**
 * `fn[key]`, `Class[key]` with a key that is not a literal: refused when the
 * object's type is a function, a class (constructor) or `any`. Needs type
 * information (parserOptions.projectService); literal keys and dot access are
 * left to the other rules.
 */
const noComputedFunctionMember = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const services = context.sourceCode.parserServices
    if (!services?.program) throw new Error("tenant/no-computed-function-member needs type information (parserOptions.projectService)")
    // A cast hides the value's type (`(f as never)[k]`), so every layer down to the value is checked.
    const ASSERTIONS = new Set(["TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion", "TSNonNullExpression", "ChainExpression"])
    const report = (node, objectNode) => {
      for (let current = objectNode; current; current = ASSERTIONS.has(current.type) ? current.expression : undefined) {
        if (isFunctionLike(services.getTypeAtLocation(current))) return context.report({ node, message: FUNCTION_MEMBER_MESSAGE })
      }
    }
    return {
      "MemberExpression[computed=true]"(node) {
        if (!isLiteralKey(node.property)) report(node, node.object)
      },
      // `const { [key]: value } = fn` is the same read.
      "ObjectPattern > Property[computed=true]"(node) {
        if (isLiteralKey(node.key)) return
        const pattern = node.parent
        const source = pattern.parent.type === "VariableDeclarator" ? pattern.parent.init : pattern.parent.type === "AssignmentExpression" ? pattern.parent.right : undefined
        if (source) report(node, source)
      },
    }
  },
}

tenantRules.rules["no-computed-function-member"] = noComputedFunctionMember
