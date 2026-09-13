import type { BookingDb } from "./sales_booking.ts";

const HOST = Deno.env.get("PGHOST") || "127.0.0.1";
const PORT = Deno.env.get("PGPORT") || "55581";
const DB = Deno.env.get("PGDATABASE") || "booking_test";
const USER = Deno.env.get("PGUSER") || "marninstobbe";
const PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql";

export function q(s: string) {
  return "'" + s.replace(/'/g, "''") + "'";
}

export function psql(sql: string): string {
  const cmd = new Deno.Command(PSQL, {
    args: ["-h", HOST, "-p", PORT, "-U", USER, "-d", DB, "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql],
    stdout: "piped",
    stderr: "piped",
  });
  const out = cmd.outputSync();
  if (out.code !== 0) {
    throw new Error(new TextDecoder().decode(out.stderr) || new TextDecoder().decode(out.stdout));
  }
  return new TextDecoder().decode(out.stdout).trim();
}

export function createPsqlBookingDb(): BookingDb {
  return {
    async rpc(fn, args = {}) {
      const lit = (v: unknown) => {
        if (v == null) return "null";
        if (typeof v === "boolean") return v ? "true" : "false";
        if (typeof v === "number") return String(v);
        if (typeof v === "object") return q(JSON.stringify(v)) + "::jsonb";
        return q(String(v));
      };
      const list = Object.keys(args).map((k) => lit(args[k])).join(", ");
      const raw = psql(`select ${fn}(${list})::text`);
      return { data: raw ? JSON.parse(raw) : null, error: null };
    },
    async upsert(table, row) {
      const cols = Object.keys(row);
      const vals = cols.map((c) => {
        const v = row[c];
        if (v == null) return "null";
        if (typeof v === "boolean") return v ? "true" : "false";
        if (typeof v === "number") return String(v);
        if (typeof v === "object") return q(JSON.stringify(v)) + "::jsonb";
        return q(String(v));
      });
      const pk = table === "sales_booking_drafts" || table === "sales_booking_assessments" || table === "sales_booking_archives"
        ? "case_id"
        : table === "sales_booking_cursors"
        ? "key"
        : table === "sales_booking_runner_journal" || table === "sales_booking_actions"
        ? "id"
        : table === "sales_booking_actions"
        ? "action_id"
        : "id";
      const pkCol = table === "sales_booking_actions" ? "action_id" : pk;
      const sets = cols.filter((c) => c !== pkCol).map((c) => `${c}=EXCLUDED.${c}`).join(",");
      psql(`insert into ${table} (${cols.join(",")}) values (${vals.join(",")}) on conflict (${pkCol}) do update set ${sets}`);
      return { error: null };
    },
    async selectMatch(table, match) {
      const where = Object.entries(match).map(([k, v]) => `${k}=${v == null ? "null" : q(String(v))}`).join(" and ");
      const raw = psql(`select coalesce(json_agg(t), '[]'::json) from (select * from ${table} where ${where}) t`);
      return { data: JSON.parse(raw || "[]") };
    },
  };
}
