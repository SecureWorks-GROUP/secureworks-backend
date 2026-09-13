// deno-lint-ignore-file no-explicit-any
const psql = "/opt/homebrew/opt/postgresql@17/bin/psql";
const name = (value: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw Error("Invalid SQL identifier");
  return '"' + value + '"';
};
export const literal = (value: any): string =>
  value == null
    ? "null"
    : typeof value === "number"
    ? String(value)
    : typeof value === "boolean"
    ? String(value)
    : "'" +
      (typeof value === "object" ? JSON.stringify(value) : value).replaceAll(
        "'",
        "''",
      ) + "'" + (typeof value === "object" ? "::jsonb" : "");

export async function openDispatchPg() {
  const port = Deno.env.get("DISPATCH_TEST_PGPORT") || "55581";
  if (!/^\d+$/.test(port) || Number(port) < 1024 || Number(port) > 65535) {
    throw Error("DISPATCH_TEST_PGPORT must be a local unprivileged port");
  }
  const child = new Deno.Command(psql, {
    args: [
      "-X",
      "-qAt",
      "-h",
      "127.0.0.1",
      "-p",
      port,
      "-d",
      "dispatch_test5",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  const errors = new Response(child.stderr).text();
  let buffer = "", queue = Promise.resolve();
  async function line() {
    while (!buffer.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw Error("PostgreSQL fixture stopped: " + await errors);
      buffer += next.value;
    }
    const end = buffer.indexOf("\n"), value = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    return value;
  }
  const send = (sql: string) =>
    writer.write(new TextEncoder().encode(sql + "\n"));
  const held = "dispatch_saved_" + crypto.randomUUID().replaceAll("-", "");
  await send(`begin;
set local lock_timeout='5s';
alter schema public rename to ${name(held)};
create schema public;
grant usage on schema public to anon,authenticated,service_role;
\\set APPLY_LUNA 1
\\i tests/dispatch/fixture.sql
\\i supabase/migrations/20260910112833_luna_context_source_revisions.sql
\\i supabase/migrations/20260912150402_dispatch_workbench.sql
create function pg_temp.dispatch_test_query(statement text) returns jsonb language plpgsql as $$
declare result jsonb; begin execute statement into result; return jsonb_build_object('data',result,'error',null);
exception when others then return jsonb_build_object('data',null,'error',jsonb_build_object('message',sqlerrm,'code',sqlstate)); end $$;
set role service_role;
select '{"ready":true}'::jsonb;`);
  if (!JSON.parse(await line()).ready) {
    throw Error("PostgreSQL fixture not ready");
  }
  const query = (sql: string): Promise<any> => {
    const result = queue.then(async () => {
      await send(`select pg_temp.dispatch_test_query(${literal(sql)});`);
      return JSON.parse(await line());
    });
    queue = result.then(() => {}, () => {});
    return result;
  };
  const client = {
    from: (table: string) => new Query(query, table),
    rpc: (rpc: string, args: any) => {
      const expression = `${name(rpc)}(${
        Object.entries(args).map(([k, v]) => `${name(k)}=>${literal(v)}`).join(
          ",",
        )
      })`;
      if (
        [
          "dispatch_order_reservations",
          "dispatch_claim_tasks",
          "dispatch_context_facts_for_source",
        ].includes(rpc)
      ) {
        return query(
          `select coalesce(jsonb_agg(to_jsonb(t)),'[]') from ${expression} t`,
        );
      }
      return query(`select to_jsonb(${expression})`);
    },
  };
  return {
    client,
    query,
    async close() {
      await queue;
      await send("rollback;\n\\q");
      await writer.close();
      await reader.cancel();
      const result = await child.status;
      if (!result.success) throw Error(await errors);
      await errors;
    },
  };
}
class Query {
  filters: string[] = [];
  sort: string[] = [];
  take = 1000;
  single = false;
  join = false;
  patch: any;
  constructor(
    private run: (sql: string) => Promise<any>,
    private table: string,
  ) {}
  select(columns = "*") {
    this.join = columns.includes("jobs!inner");
    return this;
  }
  eq(key: string, value: any) {
    return this.filter(key, "=", value);
  }
  gt(key: string, value: any) {
    return this.filter(key, ">", value);
  }
  gte(key: string, value: any) {
    return this.filter(key, ">=", value);
  }
  lte(key: string, value: any) {
    return this.filter(key, "<=", value);
  }
  neq(key: string, value: any) {
    return this.filter(key, "<>", value);
  }
  filter(key: string, op: string, value: any) {
    this.filters.push(
      key === "jobs.org_id"
        ? `exists(select 1 from jobs j where j.id=t.job_id and j.org_id=${
          literal(value)
        })`
        : `t.${name(key)} ${op} ${literal(value)}`,
    );
    return this;
  }
  in(key: string, values: any[]) {
    this.filters.push(
      values.length
        ? `t.${name(key)} in (${values.map(literal).join(",")})`
        : "false",
    );
    return this;
  }
  order(key: string, options?: any) {
    this.sort.push(
      `t.${name(key)} ${options?.ascending === false ? "desc" : "asc"}`,
    );
    return this;
  }
  limit(n: number) {
    this.take = Math.min(1000, n);
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }
  update(patch: any) {
    this.patch = patch;
    return this;
  }
  async execute() {
    const table = name(this.table),
      where = this.filters.length ? " where " + this.filters.join(" and ") : "";
    const sql = this.patch
      ? `with changed as(update ${table} t set ${
        Object.keys(this.patch).map((k) =>
          `${name(k)}=(jsonb_populate_record(null::${table},${
            literal(this.patch)
          })).${name(k)}`
        ).join(",")
      }${where} returning *)select coalesce(jsonb_agg(to_jsonb(changed)),'[]') from changed`
      : `select coalesce(jsonb_agg(row),'[]') from (select to_jsonb(t)${
        this.join
          ? "||jsonb_build_object('jobs',(select to_jsonb(j) from jobs j where j.id=t.job_id))"
          : ""
      } as row from ${table} t${where}${
        this.sort.length ? " order by " + this.sort.join(",") : ""
      } limit ${this.take}) selected`;
    const result = await this.run(sql);
    return {
      ...result,
      data: this.single ? result.data?.[0] || null : result.data,
    };
  }
  then(resolve: any, reject: any) {
    return this.execute().then(resolve, reject);
  }
}
