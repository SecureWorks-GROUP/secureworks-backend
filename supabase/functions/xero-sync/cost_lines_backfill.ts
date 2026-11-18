import { billCostDocument } from "./cost_lines.ts";
import { readBillMirrorVerdicts } from "./trade_bill_mirror_rule.ts";
import { type LabourAccounts, labourAccounts, readPeopleAccounts } from "../_shared/people_accounts.ts";

const PAGE_SIZE = 200;
const MAX_PAGES = 10;
// Per request, not per page. Return the last committed invoice for the next ask.
export const MAX_TRADE_RPCS = 20;
const BILL_COLUMNS =
  "xero_invoice_id,invoice_type,status,invoice_number,invoice_date,xero_contact_id,contact_name,fully_paid_on,line_items,sub_total,cost_line_amount_types:raw_json->LineAmountTypes";
type Kind = "bills" | "credits" | "trade";
type Input = { kind: Kind; after?: string; pages?: number };

function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : String((error as any)?.message ?? error);
}

// Any refused write retains the last committed cursor. Existing RPCs own all
// amounts, person decisions and idempotence; this action never sets cutover.
export async function backfillCostLines(sb: any, orgId: string, input: Input) {
  let after = input?.after ?? null;
  let done = 0;
  // Bills not written because only a trade invoice with no organisation holds them.
  let mirrorStops = 0;
  const stops = () => (input?.kind === "bills" ? { mirrors_stopped: mirrorStops } : {});
  try {
    if (
      !input || !["bills", "credits", "trade"].includes(input.kind) ||
      (after !== null && (typeof after !== "string" || !after.length)) ||
      !Number.isInteger(input.pages ?? 1) || (input.pages ?? 1) < 1 ||
      (input.pages ?? 1) > MAX_PAGES
    ) throw new Error("Invalid kind, cursor or pages (1..10)");
    const { data: flag, error: flagError } = await sb.from("feature_flags")
      .select("enabled").eq("flag_name", "job_cost_lines_sync_v1")
      .maybeSingle();
    if (flagError) throw flagError;
    if (flag?.enabled !== true) return { skipped: "switch_off" };
    let employerSuperOn = false;
    let labour: LabourAccounts = labourAccounts([]);
    if (input.kind === "bills") {
      const { data, error } = await sb.from("feature_flags").select("enabled")
        .eq("flag_name", "job_cost_employer_super_v1").maybeSingle();
      if (error) throw error;
      employerSuperOn = data?.enabled === true;
      // The labour accounts (people_account_codes); unreadable or empty throws before any write.
      labour = (await readPeopleAccounts(sb)).labour;
    }
    for (let page = 0; page < (input.pages ?? 1); page++) {
      const table = input.kind === "bills"
        ? "xero_invoices"
        : input.kind === "credits"
        ? "xero_supplier_credit_notes"
        : "trade_invoices";
      const key = input.kind === "bills"
        ? "xero_invoice_id"
        : input.kind === "credits"
        ? "xero_credit_note_id"
        : "id";
      // Keyset reads reuse xero_invoices(org_id,xero_invoice_id) UNIQUE,
      // xero_supplier_credit_notes(org_id,xero_credit_note_id) PK and trade_invoices PK.
      let query = sb.from(table).select(
        input.kind === "bills" ? BILL_COLUMNS : key,
      )
        .eq("org_id", orgId).order(key).limit(
          input.kind === "trade"
            ? Math.min(PAGE_SIZE, MAX_TRADE_RPCS - done)
            : PAGE_SIZE,
        );
      if (input.kind === "bills") query = query.eq("invoice_type", "ACCPAY");
      if (after !== null) query = query.gt(key, after);
      const { data: rows, error } = await query;
      if (error || !Array.isArray(rows)) {
        throw error ?? new Error("Document page unavailable");
      }
      if (!rows.length) return { kind: input.kind, done, next_after: null, ...stops() };
      if (input.kind === "trade") {
        for (const row of rows) {
          await write(sb, "job_cost_lines_sync_trade_invoice", {
            p_trade_invoice_id: row.id,
          });
          after = row.id;
          done++;
        }
      } else {
        if (input.kind === "credits") {
          await write(sb, "job_cost_lines_sync_credit_notes", {
            p_credit_note_ids: rows.map((r: any) => r[key]),
          });
        } else {
          // The one mirror rule (trade_bill_mirror_rule.ts). An unreadable or
          // incomplete answer throws before any write or cursor movement.
          const verdicts = await readBillMirrorVerdicts(
            sb,
            orgId,
            rows.map((r: any) => r.xero_invoice_id),
          );
          const mirrors = verdicts.mirrors;
          const documents = rows.filter((row: any) => !verdicts.stopped.has(row.xero_invoice_id)).map((row: any) =>
            billCostDocument({
              ...row,
              raw_json: { LineAmountTypes: row.cost_line_amount_types },
            }, { orgId, mirrorBillIds: mirrors, employerSuperOn, labour })
          ).filter((d: unknown) => d !== null);
          if (documents.length) {
            await write(sb, "job_cost_lines_upsert_documents", {
              p_docs: documents,
            });
          }
          mirrorStops += rows.filter((r: any) => verdicts.stopped.has(r.xero_invoice_id)).length;
        }
        after = rows[rows.length - 1][key];
        done += rows.length;
      }
      // A non-empty page always returns its last source id, even when every
      // row was a mirror. An empty follow-up is the explicit completion proof.
      if (input.kind === "trade" && done >= MAX_TRADE_RPCS) break;
      if (rows.length < PAGE_SIZE) break;
    }
    return { kind: input.kind, done, next_after: after, ...stops() };
  } catch (error) {
    return {
      kind: input?.kind,
      done,
      next_after: after,
      ...stops(),
      error: message(error),
    };
  }
}

async function write(sb: any, name: string, args: Record<string, unknown>) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  if (!data || data.ran === false) {
    throw new Error(data?.reason ?? "Cost writer unavailable");
  }
}

export async function handleCostLinesBackfill(
  req: Request,
  sb: any,
  orgId: string,
  serviceKey: string,
): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  // Only exact server-key possession. A signed-in user's JWT or the ops key
  // cannot enter this maintenance command, regardless of gateway settings.
  if (
    !serviceKey || req.headers.get("authorization") !== `Bearer ${serviceKey}`
  ) return json({ error: "Service key required" }, 403);
  if (req.method !== "POST") return json({ error: "POST required" }, 405);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "JSON body required" }, 400);
  }
  const result = await backfillCostLines(sb, orgId, body);
  return json(result, "error" in result ? 409 : 200);
}
