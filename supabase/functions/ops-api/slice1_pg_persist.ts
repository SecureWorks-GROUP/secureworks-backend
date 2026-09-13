/** Real booking_test PostgreSQL persist proof. Isolated 127.0.0.1:55581. */
import { persistDraft, type BookingActor, type BookingDb } from "./sales_booking.ts";

const HOST = Deno.env.get("PGHOST") || "127.0.0.1";
const PORT = Deno.env.get("PGPORT") || "55581";
const DB = Deno.env.get("PGDATABASE") || "booking_test";
const USER = Deno.env.get("PGUSER") || "marninstobbe";
const PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql";
const ORG = "00000000-0000-0000-0000-000000000001";
const CASE_ID = "sql-slice1-case";
const ACTOR: BookingActor = { org_id: ORG, user_id: "00000000-0000-0000-0000-000000000002", role: "admin" };
const TEXT = "AI-proposed Thursday 1:00pm. Customer date unspecified.";

function q(s: string) {
  return "'" + s.replace(/'/g, "''") + "'";
}

function psql(sql: string): string {
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

function createPsqlBookingDb(): BookingDb {
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
        return q(String(v));
      });
      const pk = table === "sales_booking_drafts" ? "case_id" : "id";
      const sets = cols.filter((c) => c !== pk).map((c) => `${c}=EXCLUDED.${c}`).join(",");
      psql(`insert into ${table} (${cols.join(",")}) values (${vals.join(",")}) on conflict (${pk}) do update set ${sets}`);
      return { error: null };
    },
    async selectMatch(table, match) {
      const where = Object.entries(match).map(([k, v]) => `${k}=${v == null ? "null" : q(String(v))}`).join(" and ");
      const raw = psql(`select coalesce(json_agg(t), '[]'::json) from (select * from ${table} where ${where}) t`);
      return { data: JSON.parse(raw || "[]") };
    },
  };
}

psql(`insert into sales_booking_cases (id, resource_id, org_id, display_name, status)
      values (${q(CASE_ID)}, 'nithin', ${q(ORG)}, 'Enquiry', 'needs_decision')
      on conflict (id) do update set display_name=excluded.display_name`);
psql(`delete from sales_booking_drafts where case_id=${q(CASE_ID)}`);
const db = createPsqlBookingDb();
const saved = await persistDraft(db, { case_id: CASE_ID, text: TEXT, human_edited: true, sender: "+61489267774", expected_revision: 0 }, ACTOR) as { revision: number };
if (Number(saved.revision) !== 1) throw new Error("expected SQL revision 1, got " + saved.revision);
let conflict = false;
try {
  await persistDraft(db, { case_id: CASE_ID, text: "stale", expected_revision: 0 }, ACTOR);
} catch (e) {
  conflict = (e as { code?: string }).code === "cas_conflict";
}
if (!conflict) throw new Error("SQL CAS did not reject stale expected_revision");
const row = JSON.parse(psql(`select row_to_json(t) from sales_booking_drafts t where case_id=${q(CASE_ID)}`));
if (row.text !== TEXT || Number(row.revision) !== 1) throw new Error("SQL table reload mismatch");
console.log(JSON.stringify({
  ok: true,
  database: DB,
  host: HOST + ":" + PORT,
  handler: "persistDraft -> sales_booking_cas_draft",
  revision: Number(row.revision),
  cas_conflict_on_stale: true,
  sql_reload_matches: true,
}));
