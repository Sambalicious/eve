import { describe, expect, it } from "vitest"

import { refusedStatementReason } from "./scoped-statement.js"

/** Run a2c invariant 2: the text check TenantDatabase runs on every scoped statement before it is sent. */
describe("refusedStatementReason: transaction control and multiple statements are refused", () => {
  it.each([
    "begin", "BEGIN WORK", "start transaction", "Start Transaction isolation level serializable", "commit", "COMMIT PREPARED 'x'", "end", "end transaction",
    "rollback", "rollback to savepoint s", "ROLLBACK PREPARED 'x'", "abort", "savepoint s1", "release savepoint s1", "release s1", "prepare transaction 'x'",
    "set transaction isolation level read committed", "set session characteristics as transaction read only", "set session authorization default",
    "set local session authorization default", "reset all", "reset eve.candidate_id", "RESET session authorization",
    "  \n\t commit", "/* lead */ commit", "-- lead\ncommit", "/* outer /* inner */ still comment */ rollback",
  ])("refuses %j", (text) => {
    expect(refusedStatementReason(text)).toBe("transaction_control")
  })

  it.each([
    "select 1; commit", "select 1;select 2", "update t set a = 1; select 1", "select ';' as a; commit", "select 1 /* ; */ ; select 2",
    "select $$;$$; select 2", "select $tag$ $$ ; $tag$; select 2", "select E'\\';'; select 2", "select \"a;\"; select 2",
  ])("refuses more than one statement in %j", (text) => {
    expect(refusedStatementReason(text)).toBe("multiple_statements")
  })

  it.each([
    "select 1", "select 1;", "select 1 ;  \n", "select 1; -- trailing comment", "select ';' as semi", "select 'it''s; fine'", "select E'a\\'; b'",
    "select $$ commit; $$", "select $q$ a ; b $q$", "select $1::int", "select \"commit\" from t", "select 1 /* ; commit */",
    "insert into approved_answer (value) values ('begin; commit')", "set local statement_timeout = 5000", "set local lock_timeout = 1000",
    "with x as (select 1) select * from x", "select set_config('eve.candidate_id', $1, true), public.bind_candidate($2::uuid)",
    "update application set state = 'begin'", "delete from t where note = 'reset'", "select 1 as release", "select pg_advisory_xact_lock(hashtext($1))",
  ])("accepts %j", (text) => {
    expect(refusedStatementReason(text)).toBeUndefined()
  })

  it("an unterminated quote or comment is refused rather than guessed at", () => {
    expect(refusedStatementReason("select 'abc")).toBe("unparsable")
    expect(refusedStatementReason("select 1 /* open")).toBe("unparsable")
    expect(refusedStatementReason("select $$ open")).toBe("unparsable")
  })
})

/** Run a2c repair wave 2 (F-SEC-13, F-SEC-14): only one data statement, as text, and nothing that outlives the scope. */
describe("refusedStatementReason (repair wave 2): text and statement kind", () => {
  it.each([[undefined], [null], [42], [{}], [["select 1"]], [""], ["   \n"], ["-- only a comment"], ["/* only */"], [";"]])("refuses %j: a statement must be non-empty text", (value) => {
    expect(refusedStatementReason(value)).toBe("not_text")
  })

  it.each([
    "set statement_timeout = 0", "SET search_path = evil", "set session work_mem = '1GB'", "set eve.leak = 'x'", "set role none",
    "create temp table t (x int)", "CREATE TEMPORARY TABLE t AS select 1", "create function f() returns int as $$ select 1 $$ language sql",
    "prepare p as select 1", "execute p", "deallocate all", "listen channel", "unlisten *", "notify channel", "do $$ begin perform 1; end $$",
    "copy approved_answer to stdout", "lock table approved_answer", "declare c cursor with hold for select 1", "discard all", "load 'x'",
    "select 1 into temp t", "select * into t from approved_answer", "with x as (select 1) select * into t from x", "alter table t add x int", "drop table t",
    "truncate approved_answer", "vacuum", "analyze", "explain select 1", "show search_path", "call p()", "grant select on t to public", "refresh materialized view m",
    "\"set\" statement_timeout = 0", "U&\"set\" x = 1",
  ])("refuses %j: not a data statement", (text) => {
    expect(refusedStatementReason(text)).toMatch(/^(not_data_statement|unparsable)$/)
  })

  it.each([
    "select set_config('eve.leak', 'x', false)", "select set_config('eve.leak', 'x', $1)", "select pg_catalog.set_config('a', 'b', false)",
    "select \"set_config\"('a', 'b', false)", "select * from set_config('a', 'b', false)", "select set_config('a', 'b')",
    "select pg_advisory_lock(1)", "select pg_try_advisory_lock(1, 2)", "select pg_advisory_lock_shared(1)", "select pg_try_advisory_lock_shared($1)",
    "select pg_advisory_unlock(1)", "select pg_advisory_unlock_all()", "select \"pg_advisory_lock\"(1)", "with x as (select pg_advisory_lock(1)) select 1",
    "update t set a = (select pg_advisory_lock(1))",
  ])("refuses %j: session-level state", (text) => {
    expect(refusedStatementReason(text)).toBe("session_state")
  })

  it("refuses a unicode-escaped identifier rather than guess what it names", () => {
    expect(refusedStatementReason("select U&\"\\0073et_config\"('a', 'b', false)")).toBe("unparsable")
  })

  it.each([
    "select 1", "SELECT * FROM approved_answer", "insert into approved_answer (value) values ($1)", "update approved_answer set value = $1", "delete from approved_answer",
    "with x as (select 1) select * from x", "with x as (select 1) insert into t select * from x", "merge into t using s on true when matched then do nothing",
    "(select 1) union (select 2)", "set local statement_timeout = 5000", "SET LOCAL lock_timeout = 1000", "select pg_advisory_xact_lock(1)", "select pg_try_advisory_xact_lock(1)",
    "select pg_advisory_xact_lock_shared(1)", "select set_config('eve.candidate_id', $1, true)", "select set_config('a', 'b', TRUE)", "select 'set_config(1,2,false)'",
    "select \"into\" from t", "insert into t (\"select\") values (1) returning id", "select current_setting('eve.candidate_id', true)", "select 1 for update",
  ])("accepts %j", (text) => {
    expect(refusedStatementReason(text)).toBeUndefined()
  })
})

describe("refusedStatementReason (repair wave 2): built-in functions that run SQL text", () => {
  it.each(["select query_to_xml('select 1', true, true, '')", "select pg_catalog.query_to_xmlschema($1, true, true, '')", "select query_to_xml_and_xmlschema('x', true, true, '')", "select cursor_to_xml('c', 1, true, true, '')", "select * from ts_stat('select v from t')", "select ts_rewrite('a'::tsquery, 'select 1')"])("refuses %j", (text) => {
    expect(refusedStatementReason(text)).toBe("dynamic_sql")
  })
})
