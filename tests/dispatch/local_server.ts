// Isolated browser integration transport. Runs the production handler/reducer/RPC.
// It deliberately omits JWT verification/provider calls and Supabase projection
// behavior; use only the named loopback fixture, never a production connection.
// deno-lint-ignore-file no-explicit-any
import { dispatchExecutionState } from "../../supabase/functions/ops-api/dispatch_execution.ts";
import {
  DispatchError,
  handleDispatch,
} from "../../supabase/functions/ops-api/dispatch_workbench.ts";
const PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql";
const DATABASE = "dispatch_ui";
const ORG = "00000000-0000-4000-8000-000000000001";
const identifier = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw Error("Invalid fixture identifier");
  return '"' + s + '"';
};
const literal = (x: any): string =>
  x === null
    ? "null"
    : typeof x === "number"
    ? String(x)
    : typeof x === "boolean"
    ? String(x)
    : "'" +
      (typeof x === "object" ? JSON.stringify(x) : String(x)).replaceAll(
        "'",
        "''",
      ) + "'" + (typeof x === "object" ? "::jsonb" : "");
async function sql(statement: string) {
  const p = new Deno.Command(PSQL, {
    args: [
      "-h",
      "127.0.0.1",
      "-p",
      "55581",
      "-d",
      DATABASE,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      statement,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const r = await p.output();
  if (!r.success) throw Error(new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout).trim();
}
class Query {
  filters: string[] = [];
  orders: string[] = [];
  take = 1000;
  single = false;
  join = false;
  operation = "select";
  values: any;
  options: any;
  constructor(public table: string, private run = sql) {
    identifier(table);
  }
  select(columns = "*") {
    this.join = columns.includes("jobs!inner");
    return this;
  }
  eq(k: string, v: any) {
    return this.filter(k, "=", v);
  }
  gt(k: string, v: any) {
    return this.filter(k, ">", v);
  }
  gte(k: string, v: any) {
    return this.filter(k, ">=", v);
  }
  lte(k: string, v: any) {
    return this.filter(k, "<=", v);
  }
  neq(k: string, v: any) {
    return this.filter(k, "<>", v);
  }
  like(k: string, v: any) {
    return this.filter(k, "like", v);
  }
  in(k: string, v: any[]) {
    this.filters.push(`t.${identifier(k)} in (${v.map(literal).join(",")})`);
    return this;
  }
  filter(k: string, op: string, v: any) {
    if (k === "jobs.org_id") {
      this.filters.push(
        `exists(select 1 from jobs j where j.id=t.job_id and j.org_id=${
          literal(v)
        })`,
      );
    } else this.filters.push(`t.${identifier(k)} ${op} ${literal(v)}`);
    return this;
  }
  order(k: string, options?: any) {
    this.orders.push(
      `t.${identifier(k)} ${options?.ascending === false ? "desc" : "asc"}`,
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
  insert(v: any) {
    this.operation = "insert";
    this.values = v;
    return this;
  }
  upsert(v: any, options: any) {
    this.operation = "upsert";
    this.values = v;
    this.options = options;
    return this;
  }
  update(v: any) {
    this.operation = "update";
    this.values = v;
    return this;
  }
  or(s: string) {
    const calendar =
      /^scheduled_end.gte.(\d{4}-\d{2}-\d{2}),and\(scheduled_end.is.null,scheduled_date.gte.\1\)$/
        .exec(s);
    if (calendar) {
      this.filters.push(
        `(scheduled_end>=${
          literal(calendar[1])
        } or (scheduled_end is null and scheduled_date>=${
          literal(calendar[1])
        }))`,
      );
      return this;
    }
    const parts = s.split(",").map((p) => {
      const [key, op, ...value] = p.split(".");
      if (op !== "ilike") throw Error("Unsupported fixture filter");
      return `t.${identifier(key)} ilike ${
        literal(value.join(".").replaceAll("*", "%"))
      }`;
    });
    this.filters.push("(" + parts.join(" or ") + ")");
    return this;
  }
  async execute() {
    try {
      const table = identifier(this.table),
        where = this.filters.length
          ? " where " + this.filters.join(" and ")
          : "";
      let query: string;
      if (this.operation === "select") {
        query =
          `select coalesce(jsonb_agg(x.row),'[]'::jsonb) from (select to_jsonb(t)${
            this.join
              ? "||jsonb_build_object('jobs',(select to_jsonb(j) from jobs j where j.id=t.job_id))"
              : ""
          } as row from ${table} t${where}${
            this.orders.length ? " order by " + this.orders.join(",") : ""
          } limit ${this.take})x`;
      } else {
        const keys = Object.keys(this.values),
          record = `jsonb_populate_record(null::${table},${
            literal(this.values)
          })`;
        if (this.operation === "update") {
          query = `with changed as(update ${table} t set ${
            keys.map((k) => `${identifier(k)}=(${record}).${identifier(k)}`)
              .join(",")
          }${where} returning *)select coalesce(jsonb_agg(to_jsonb(changed)),'[]') from changed`;
        } else {query = `with changed as(insert into ${table}(${
            keys.map(identifier).join(",")
          })select ${
            keys.map((k) => `(${record}).${identifier(k)}`).join(",")
          }${
            this.operation === "upsert"
              ? " on conflict(" +
                this.options.onConflict.split(",").map(identifier).join(",") +
                ") do nothing"
              : ""
          } returning *)select coalesce(jsonb_agg(to_jsonb(changed)),'[]') from changed`;}
      }
      const data = JSON.parse(await this.run(query));
      return { data: this.single ? (data[0] || null) : data, error: null };
    } catch (e) {
      return {
        data: null,
        error: {
          message: (e as Error).message,
          code: (e as Error).message.includes("conflict")
            ? "40001"
            : "fixture_error",
        },
      };
    }
  }
  then(resolve: any, reject: any) {
    return this.execute().then(resolve, reject);
  }
}
export function createDispatchSqlClient(run = sql) {
  return {
    from: (table: string) => new Query(table, run),
    rpc: async (name: string, args: any) => {
      try {
        if (
          ![
            "dispatch_begin_send",
            "dispatch_claim_execution",
            "dispatch_claim_tasks",
            "dispatch_commit",
            "dispatch_context_facts_for_source",
            "dispatch_enqueue_job",
            "dispatch_expire_execution_leases",
            "dispatch_finalize_task",
            "dispatch_get_execution",
            "dispatch_list_coverage",
            "dispatch_list_tasks",
            "dispatch_order_reservations",
            "dispatch_reconcile_eligible_jobs",
            "dispatch_record_execution_progress",
            "dispatch_record_execution_readback",
            "dispatch_retry_task",
            "dispatch_source_version",
          ]
            .includes(name)
        ) throw Error("Fixture RPC not allowed");
        const expression = `${identifier(name)}(${
          Object.entries(args).map(([k, v]) =>
            `${identifier(k)}=>${literal(v)}`
          )
            .join(",")
        })`;
        const setReturning = [
          "dispatch_claim_tasks",
          "dispatch_context_facts_for_source",
          "dispatch_order_reservations",
        ].includes(name);
        const query = setReturning
          ? `select coalesce(jsonb_agg(to_jsonb(x)),'[]') from ${expression} x`
          : `select to_jsonb(${expression})`;
        return { data: JSON.parse(await run(query)), error: null };
      } catch (e) {
        return {
          data: null,
          error: {
            message: (e as Error).message,
            code: (e as Error).message.includes("conflict")
              ? "40001"
              : "fixture_error",
          },
        };
      }
    },
  };
}
export const localDispatchClient = createDispatchSqlClient();
export function createDispatchLocalHandler(
  fixtureClient: any = localDispatchClient,
  fixtureOrg = ORG,
  fixtureActor = "local-fixture-operator",
) {
  return async (req: Request) => {
    const headers = {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers });
    const url = new URL(req.url);
    try {
      const body = req.method === "POST" ? await req.json() : {};
      let action = url.searchParams.get("action") || "";
      if (action === "dispatch_execution") {
        return new Response(
          JSON.stringify(
            await dispatchExecutionState(
              fixtureClient,
              fixtureOrg,
              url.searchParams.get("job_id") || "",
              false,
              true,
            ),
          ),
          { headers },
        );
      }
      if (action === "dispatch_execute") {
        return new Response(
          JSON.stringify({
            action: { id: body.approval_id, status: "held" },
            live_actions_enabled: false,
          }),
          { headers },
        );
      }
      if (action === "dispatch_draft_approve") {
        action = "dispatch_command";
        body.command = "draft_approve";
      }
      const result = await handleDispatch(
        fixtureClient,
        fixtureOrg,
        fixtureActor,
        action,
        req.method,
        url.searchParams,
        body,
      );
      return new Response(JSON.stringify(result), { headers });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: (e as Error).message, fixture: true }),
        { status: e instanceof DispatchError ? e.status : 500, headers },
      );
    }
  };
}

if (import.meta.main) {
  Deno.serve(
    { hostname: "127.0.0.1", port: 55582 },
    createDispatchLocalHandler(),
  );
}
