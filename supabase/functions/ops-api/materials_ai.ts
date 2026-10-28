// deno-lint-ignore-file no-explicit-any
// ════════════════════════════════════════════════════════════
// AI BILL READER: the staff doors (20261028173000).
//
// The reader itself runs in Jarvis and writes only through the SQL function
// materials_ai_apply. These doors let staff see what it did and take any of it
// back:
//   materials_ai_status      GET   counts, the confidence bar, calls today
//   materials_ai_placements  GET   the AI's decisions, newest first, with the
//                                  reason and evidence (view: placed | left |
//                                  undone | checked | all)
//   materials_ai_undo        POST  one-click Undo of one placement or filing:
//                                  the bill goes back to Bills to place and the
//                                  AI never reads it again
//   materials_ai_settings    POST  on/off, the confidence bar, the daily cap
//
// Never writes Xero. A person's own placement is never touched here: Undo only
// takes back the AI's own row, and refuses when a person changed the bill since.
// ════════════════════════════════════════════════════════════

export class MaterialsAiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const PLACEMENT_COLUMNS =
  "id, xero_invoice_id, invoice_number, contact_name, amount_ex, installer, decision, job_id, job_number, " +
  "confidence, bar, reason, evidence, model, outcome, refusal, replaced_machine_source, second_check_status, " +
  "second_check, second_check_at, created_at, undone_at, undone_by, undo_note";

export type PlacementView = "placed" | "left" | "undone" | "checked" | "all";

export function placementView(raw: string | null | undefined): PlacementView {
  const v = String(raw || "placed").toLowerCase();
  return (["placed", "left", "undone", "checked", "all"] as const).includes(v as PlacementView)
    ? (v as PlacementView)
    : "placed";
}

export async function materialsAiStatus(client: any): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc("materials_ai_status");
  if (error) throw new MaterialsAiError(`AI bill reader status could not be read: ${error.message}`, 503);
  return { ok: true, status: data };
}

export async function listMaterialsAiPlacements(
  client: any,
  opts: { view?: string | null; limit?: number | null; since?: string | null },
): Promise<Record<string, unknown>> {
  const view = placementView(opts.view);
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  let q = client.from("materials_ai_placements").select(PLACEMENT_COLUMNS);
  if (view === "placed") q = q.in("outcome", ["placed", "filed_not_job_related"]).is("undone_at", null);
  if (view === "left") q = q.eq("outcome", "left_for_person");
  if (view === "undone") q = q.not("undone_at", "is", null);
  if (view === "checked") q = q.in("second_check_status", ["agreed", "disagreed"]);
  if (opts.since && /^\d{4}-\d{2}-\d{2}/.test(opts.since)) q = q.gte("created_at", opts.since);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limit);
  // An unreadable list is never shown as "nothing placed".
  if (error || !Array.isArray(data)) {
    throw new MaterialsAiError(`AI placements could not be read: ${error?.message ?? "no rows"}`, 503);
  }
  return { ok: true, view, count: data.length, placements: data };
}

export async function undoMaterialsAiPlacement(
  client: any,
  args: { placementId?: string | null; actor: string; note?: string | null },
): Promise<Record<string, unknown>> {
  const id = String(args.placementId || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new MaterialsAiError("placement_id is required");
  }
  const { data, error } = await client.rpc("materials_ai_undo", {
    p_placement: id,
    p_actor: args.actor,
    p_note: args.note ?? null,
  });
  if (error) {
    const msg = String(error.message || "");
    if (msg.includes("undo_refused")) {
      throw new MaterialsAiError(msg.replace(/^.*undo_refused:\s*/, ""), 409);
    }
    throw new MaterialsAiError(`Undo failed: ${msg}`, 500);
  }
  return { ok: true, ...(data || {}) };
}

export interface SettingsPatch {
  enabled?: boolean;
  confidence_bar?: number;
  daily_call_cap?: number;
}

export function settingsPatch(body: Record<string, unknown> | null | undefined): SettingsPatch {
  const out: SettingsPatch = {};
  if (typeof body?.enabled === "boolean") out.enabled = body.enabled;
  if (body?.confidence_bar !== undefined) {
    const n = Number(body.confidence_bar);
    if (!Number.isFinite(n) || n < 0.5 || n > 0.99) throw new MaterialsAiError("confidence_bar must be between 0.5 and 0.99");
    out.confidence_bar = Math.round(n * 1000) / 1000;
  }
  if (body?.daily_call_cap !== undefined) {
    const n = Number(body.daily_call_cap);
    if (!Number.isInteger(n) || n < 0 || n > 2000) throw new MaterialsAiError("daily_call_cap must be a whole number from 0 to 2000");
    out.daily_call_cap = n;
  }
  if (Object.keys(out).length === 0) throw new MaterialsAiError("nothing to change: send enabled, confidence_bar or daily_call_cap");
  return out;
}

export async function updateMaterialsAiSettings(
  client: any,
  args: { body: Record<string, unknown>; actor: string },
): Promise<Record<string, unknown>> {
  const patch = settingsPatch(args.body);
  const { data: cur, error: rErr } = await client.from("materials_ai_settings")
    .select("confidence_bar, bar_history").eq("id", true).single();
  if (rErr || !cur) throw new MaterialsAiError(`settings could not be read: ${rErr?.message ?? "missing"}`, 503);
  const row: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString(), updated_by: args.actor };
  if (patch.confidence_bar !== undefined && Number(cur.confidence_bar) !== patch.confidence_bar) {
    const history = Array.isArray(cur.bar_history) ? cur.bar_history : [];
    row.bar_history = [...history, {
      at: new Date().toISOString(),
      why: "person",
      by: args.actor,
      from: Number(cur.confidence_bar),
      to: patch.confidence_bar,
    }];
  }
  const { data, error } = await client.from("materials_ai_settings").update(row).eq("id", true).select().single();
  if (error) throw new MaterialsAiError(`settings not saved: ${error.message}`, 500);
  return { ok: true, settings: data };
}
