// deno-lint-ignore-file no-explicit-any
// Dispatch slice 4: Materials by supplier. The one read and the six writes.
// Contract: docs/dispatch-slice-4-contract.md. Rules: dispatch_materials.ts.
//
// Every function here reads or writes ONLY the job row (read), the three
// Dispatch tables (job_material_suppliers, job_material_lines,
// job_dispatch_workings), the supplier contacts (read) and the job's
// purchase orders (read). No write to jobs, suppliers or purchase_orders; no
// job_events or business_events row; no outside call of any kind. Who changed
// a row and when is kept on the row.
//
// PostgREST returns errors, it does not throw: every read and write below
// reads `error`. A failed read is never "nothing there".

import {
  cleanDispatchDescription,
  cleanDispatchQuantity,
  cleanDispatchSketch,
  cleanDispatchStatus,
  cleanDispatchUnit,
  cleanDispatchWorkingOut,
  DISPATCH_MATERIAL_LINE_SELECT,
  DISPATCH_MATERIAL_LINES_PER_JOB_MAX,
  DISPATCH_MATERIAL_SUPPLIER_SELECT,
  DISPATCH_MATERIALS_LIST_SELECT,
  DISPATCH_ORDER_SELECT,
  DISPATCH_SUPPLIER_CONTACT_SELECT,
  DISPATCH_WORKINGS_SELECT,
  dispatchCanSuggest,
  type DispatchMaterialCounts,
  dispatchMaterialCounts,
  dispatchSuggestedLines,
  isDispatchUuid,
  projectDispatchMaterialLine,
  projectDispatchMaterialSupplier,
  projectDispatchOrder,
  projectDispatchWorkings,
} from "./dispatch_materials.ts";
import {
  DISPATCH_FAMILY_PROJECTION,
  dispatchWorkType,
} from "./dispatch_job_list.ts";
import { fetchAllRows } from "./makesafe_compact_reads.ts";

export class DispatchMaterialsError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(
    status: number,
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = status;
    this.body = { error: message, code, ...extra };
  }
}

export type DispatchMaterialsActor = {
  // The signed-in user; null for the privileged ops key.
  userId: string | null;
  // The verified session's email, else the operator_email the screen stamps.
  email: string | null;
  // The signed-in user's organisation; null for the ops key.
  orgId: string | null;
};

export type DispatchMaterialsContext = {
  orgId: string;
  actor: DispatchMaterialsActor;
  // ops-api's extractMaterialsFromScope, passed in unchanged. It is always
  // called with null pricing, so the quote-lines fallback can never run.
  extractMaterialsFromScope: (scopeJson: unknown, pricingJson: null) => any[];
  now?: () => string;
};

export const DISPATCH_MATERIALS_ACTIONS = [
  "dispatch_materials",
  "dispatch_materials_add_supplier",
  "dispatch_materials_remove_supplier",
  "dispatch_materials_save_line",
  "dispatch_materials_delete_line",
  "dispatch_materials_suggest",
  "dispatch_materials_save_workings",
] as const;

export const DISPATCH_MATERIALS_WRITE_ACTIONS = DISPATCH_MATERIALS_ACTIONS
  .filter((action) => action !== "dispatch_materials");

const JOB_SELECT = "id, org_id, job_number, type, " +
  DISPATCH_FAMILY_PROJECTION.join(", ");

function readFailed(label: string, error: any): never {
  console.error(`[dispatch_materials] ${label} failed:`, error);
  throw new DispatchMaterialsError(
    500,
    "materials_read_failed",
    `${label} failed`,
  );
}

function writeFailed(label: string, error: any): never {
  console.error(`[dispatch_materials] ${label} failed:`, error);
  throw new DispatchMaterialsError(
    500,
    "materials_write_failed",
    `${label} failed`,
  );
}

function badRequest(message: string): never {
  throw new DispatchMaterialsError(400, "invalid_request", message);
}

function nowIso(ctx: DispatchMaterialsContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

function errorCode(error: any): string {
  return String(error?.code || "");
}

// ── The job ─────────────────────────────────────────────────────────────────

type DispatchJob = {
  id: string;
  org_id: string;
  job_number: string | null;
  work_type: string;
};

async function loadDispatchJob(
  client: any,
  jobIdInput: unknown,
  ctx: DispatchMaterialsContext,
): Promise<DispatchJob> {
  const jobId = typeof jobIdInput === "string" ? jobIdInput.trim() : "";
  if (!jobId) badRequest("job_id required");
  if (!isDispatchUuid(jobId)) badRequest("job_id must be a uuid");
  const { data: job, error } = await client.from("jobs")
    .select(JOB_SELECT)
    .eq("id", jobId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) readFailed("job read", error);
  if (
    !job || String(job.org_id || "") !== ctx.orgId ||
    (ctx.actor.orgId && String(job.org_id || "") !== ctx.actor.orgId)
  ) {
    throw new DispatchMaterialsError(404, "job_not_found", "Job not found");
  }
  // Repair wins over the stored type, by the Dispatch list's own rule, so a
  // repair-family job stored as makesafe is allowed.
  const workType = dispatchWorkType(job);
  if (workType === "makesafe") {
    throw new DispatchMaterialsError(
      409,
      "not_dispatch_work",
      "Materials by supplier is not offered on a make-safe job",
    );
  }
  return {
    id: job.id,
    org_id: job.org_id,
    job_number: job.job_number ?? null,
    work_type: workType,
  };
}

function bodyJobId(body: any): unknown {
  return body?.job_id ?? body?.jobId;
}

// After a write: the job's counts by the one rule. A failed read here does
// not undo a write that landed, so the answer carries `counts: null` rather
// than a made-up zero; the screen keeps the figure it had.
async function readJobCounts(
  client: any,
  jobId: string,
): Promise<DispatchMaterialCounts | null> {
  const { data, error } = await client.from("job_material_lines")
    .select(DISPATCH_MATERIALS_LIST_SELECT)
    .eq("job_id", jobId);
  if (error) {
    console.error("[dispatch_materials] counts read failed:", error);
    return null;
  }
  return dispatchMaterialCounts(data || []);
}

async function readLineById(client: any, id: string) {
  const { data, error } = await client.from("job_material_lines")
    .select(DISPATCH_MATERIAL_LINE_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) readFailed("line read", error);
  return data || null;
}

async function readChosenSupplier(
  client: any,
  jobId: string,
  supplierId: string,
) {
  const { data, error } = await client.from("job_material_suppliers")
    .select(DISPATCH_MATERIAL_SUPPLIER_SELECT)
    .eq("job_id", jobId)
    .eq("supplier_id", supplierId)
    .maybeSingle();
  if (error) readFailed("chosen supplier read", error);
  return data || null;
}

async function nextPosition(client: any, table: string, jobId: string) {
  const { data, error } = await client.from(table)
    .select("position")
    .eq("job_id", jobId)
    .order("position", { ascending: false })
    .limit(1);
  if (error) readFailed(`${table} position read`, error);
  const top = Array.isArray(data) && data.length > 0
    ? Number(data[0]?.position)
    : 0;
  return (Number.isFinite(top) ? top : 0) + 1;
}

async function countJobLines(client: any, jobId: string): Promise<number> {
  const { count, error } = await client.from("job_material_lines")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  if (error) readFailed("line count", error);
  return Number(count) || 0;
}

function supplierNotOnJob(): never {
  throw new DispatchMaterialsError(
    409,
    "supplier_not_on_job",
    "That supplier is not chosen for this job",
  );
}

function lineOnOrder(stored: any): never {
  throw new DispatchMaterialsError(
    409,
    "line_on_order",
    "This line is on a purchase order and cannot be changed here",
    { line: projectDispatchMaterialLine(stored) },
  );
}

function lineChanged(stored: any): never {
  throw new DispatchMaterialsError(
    409,
    "line_changed",
    "This line changed somewhere else",
    { line: projectDispatchMaterialLine(stored) },
  );
}

function lineNotOnJob(): never {
  throw new DispatchMaterialsError(
    409,
    "line_not_on_job",
    "That line belongs to another job",
  );
}

// ── The read ────────────────────────────────────────────────────────────────

export async function readDispatchMaterials(
  client: any,
  params: { get(name: string): string | null },
  ctx: DispatchMaterialsContext,
) {
  const job = await loadDispatchJob(
    client,
    params.get("job_id") ?? params.get("jobId"),
    ctx,
  );

  const [chosenRes, linesRes, workingsRes, ordersRes] = await Promise.all([
    client.from("job_material_suppliers")
      .select(DISPATCH_MATERIAL_SUPPLIER_SELECT)
      .eq("job_id", job.id)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    // Never capped: paged past PostgREST's 1000-row ceiling.
    fetchAllRows<any>(
      () =>
        client.from("job_material_lines")
          .select(DISPATCH_MATERIAL_LINE_SELECT)
          .eq("job_id", job.id)
          .order("position", { ascending: true })
          .order("created_at", { ascending: true }),
      "dispatch_materials.lines",
      "id",
    ).then(
      (data) => ({ data, error: null }),
      (error) => ({ data: null, error }),
    ),
    client.from("job_dispatch_workings")
      .select(DISPATCH_WORKINGS_SELECT)
      .eq("job_id", job.id)
      .maybeSingle(),
    // purchase_orders.status is NOT NULL live, so neq drops no row it should keep.
    client.from("purchase_orders")
      .select(DISPATCH_ORDER_SELECT)
      .eq("job_id", job.id)
      .eq("org_id", ctx.orgId)
      .neq("status", "deleted")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  ]);
  if (chosenRes.error) readFailed("chosen suppliers read", chosenRes.error);
  if (linesRes.error) readFailed("lines read", linesRes.error);
  if (workingsRes.error) readFailed("workings read", workingsRes.error);

  const chosen: any[] = chosenRes.data || [];
  const contactsById = new Map<string, any>();
  if (chosen.length > 0) {
    const { data: contacts, error: contactsError } = await client
      .from("suppliers")
      .select(DISPATCH_SUPPLIER_CONTACT_SELECT)
      .in("id", chosen.map((row) => row.supplier_id))
      .eq("org_id", ctx.orgId);
    if (contactsError) readFailed("supplier contacts read", contactsError);
    for (const contact of contacts || []) {
      contactsById.set(String(contact.id), contact);
    }
  }

  const lines: any[] = linesRes.data || [];
  const answer: Record<string, unknown> = {
    job_id: job.id,
    job_number: job.job_number,
    work_type: job.work_type,
    suppliers: chosen.map((row) =>
      projectDispatchMaterialSupplier(
        row,
        contactsById.get(String(row.supplier_id)),
      )
    ),
    lines: lines.map(projectDispatchMaterialLine),
    counts: dispatchMaterialCounts(lines),
    can_suggest: dispatchCanSuggest(job.work_type, lines.length),
    workings: projectDispatchWorkings(workingsRes.data),
  };
  // A failed orders read must not hide the working lines.
  if (ordersRes.error) {
    console.error("[dispatch_materials] orders read failed:", ordersRes.error);
    answer.orders_status = "failed";
  } else {
    answer.orders = (ordersRes.data || []).map(projectDispatchOrder);
    answer.orders_status = "ok";
  }
  return answer;
}

// ── Suppliers ───────────────────────────────────────────────────────────────

export async function addDispatchMaterialSupplier(
  client: any,
  body: any,
  ctx: DispatchMaterialsContext,
) {
  const job = await loadDispatchJob(client, bodyJobId(body), ctx);
  const supplierId = body?.supplier_id;
  if (!isDispatchUuid(supplierId)) badRequest("supplier_id must be a uuid");

  const { data: contact, error: contactError } = await client.from("suppliers")
    .select(DISPATCH_SUPPLIER_CONTACT_SELECT)
    .eq("id", supplierId)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (contactError) readFailed("supplier contact read", contactError);
  if (!contact || String(contact.org_id || "") !== ctx.orgId) {
    throw new DispatchMaterialsError(
      404,
      "supplier_not_found",
      "Supplier contact not found",
    );
  }

  const existing = await readChosenSupplier(client, job.id, supplierId);
  if (existing) {
    return {
      success: true,
      unchanged: true,
      supplier: projectDispatchMaterialSupplier(existing, contact),
      counts: await readJobCounts(client, job.id),
    };
  }
  if (contact.is_active !== true) {
    throw new DispatchMaterialsError(
      409,
      "supplier_inactive",
      "That supplier contact is not active",
    );
  }

  const position = await nextPosition(client, "job_material_suppliers", job.id);
  const { data: inserted, error: insertError } = await client
    .from("job_material_suppliers")
    .insert({
      org_id: job.org_id,
      job_id: job.id,
      supplier_id: supplierId,
      supplier_name: contact.name,
      position,
      created_at: nowIso(ctx),
      created_by: ctx.actor.userId,
      created_by_email: ctx.actor.email,
    })
    .select(DISPATCH_MATERIAL_SUPPLIER_SELECT)
    .single();
  if (insertError) {
    // Chosen by another tab between the read and the insert.
    if (errorCode(insertError) === "23505") {
      const raced = await readChosenSupplier(client, job.id, supplierId);
      if (raced) {
        return {
          success: true,
          unchanged: true,
          supplier: projectDispatchMaterialSupplier(raced, contact),
          counts: await readJobCounts(client, job.id),
        };
      }
    }
    writeFailed("supplier insert", insertError);
  }
  return {
    success: true,
    supplier: projectDispatchMaterialSupplier(inserted, contact),
    counts: await readJobCounts(client, job.id),
  };
}

export async function removeDispatchMaterialSupplier(
  client: any,
  body: any,
  ctx: DispatchMaterialsContext,
) {
  const job = await loadDispatchJob(client, bodyJobId(body), ctx);
  const supplierId = body?.supplier_id;
  if (!isDispatchUuid(supplierId)) badRequest("supplier_id must be a uuid");

  const existing = await readChosenSupplier(client, job.id, supplierId);
  if (!existing) {
    return {
      success: true,
      unchanged: true,
      counts: await readJobCounts(client, job.id),
    };
  }
  const hasLines = () => {
    throw new DispatchMaterialsError(
      409,
      "supplier_has_lines",
      "Move or remove this supplier's lines first",
    );
  };
  const { data: anyLine, error: lineError } = await client
    .from("job_material_lines")
    .select("id")
    .eq("job_id", job.id)
    .eq("supplier_id", supplierId)
    .limit(1);
  if (lineError) readFailed("supplier lines read", lineError);
  if (Array.isArray(anyLine) && anyLine.length > 0) hasLines();

  const { error: deleteError } = await client.from("job_material_suppliers")
    .delete()
    .eq("job_id", job.id)
    .eq("supplier_id", supplierId);
  if (deleteError) {
    // A line landed under it between the read and the delete: the foreign key
    // refuses, and nothing is deleted.
    if (errorCode(deleteError) === "23503") hasLines();
    writeFailed("supplier delete", deleteError);
  }
  return { success: true, counts: await readJobCounts(client, job.id) };
}

// ── Lines ───────────────────────────────────────────────────────────────────

function fieldOrBadRequest<T>(
  result: { ok: true; value: T } | { ok: false; error: string },
): T {
  if (!result.ok) badRequest(result.error);
  return result.value;
}

export async function saveDispatchMaterialLine(
  client: any,
  body: any,
  ctx: DispatchMaterialsContext,
) {
  const job = await loadDispatchJob(client, bodyJobId(body), ctx);
  const input = body?.line;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    badRequest("line required");
  }
  if (!isDispatchUuid(input.id)) badRequest("line.id must be a uuid");
  if (!isDispatchUuid(input.supplier_id)) {
    badRequest("line.supplier_id must be a uuid");
  }
  const description = fieldOrBadRequest(
    cleanDispatchDescription(input.description),
  );
  const quantity = fieldOrBadRequest(cleanDispatchQuantity(input.quantity));
  const unit = fieldOrBadRequest(cleanDispatchUnit(input.unit));
  const status = input.status === undefined
    ? undefined
    : fieldOrBadRequest(cleanDispatchStatus(input.status));
  const expected = body?.expected_updated_at;
  if (
    expected !== undefined && expected !== null && typeof expected !== "string"
  ) {
    badRequest("expected_updated_at must be a timestamp");
  }

  const stored = await readLineById(client, input.id);
  if (stored && String(stored.job_id) !== job.id) lineNotOnJob();

  const now = nowIso(ctx);
  if (stored) {
    if (stored.purchase_order_id) lineOnOrder(stored);
    // No expected stamp on a line that exists: a retried insert. Return the
    // stored line and write nothing.
    if (expected === undefined || expected === null) {
      return {
        success: true,
        unchanged: true,
        line: projectDispatchMaterialLine(stored),
        counts: await readJobCounts(client, job.id),
      };
    }
    const chosen = await readChosenSupplier(client, job.id, input.supplier_id);
    if (!chosen) supplierNotOnJob();
    const patch: Record<string, unknown> = {
      supplier_id: input.supplier_id,
      description,
      quantity,
      unit,
      status: status ?? stored.status,
      updated_at: now,
      updated_by: ctx.actor.userId,
      updated_by_email: ctx.actor.email,
    };
    // Moving a line puts it last in the job.
    if (String(stored.supplier_id) !== input.supplier_id) {
      patch.position = await nextPosition(client, "job_material_lines", job.id);
    }
    const { data: updated, error: updateError } = await client
      .from("job_material_lines")
      .update(patch)
      .eq("id", input.id)
      .eq("job_id", job.id)
      .eq("updated_at", expected)
      .is("purchase_order_id", null)
      .select(DISPATCH_MATERIAL_LINE_SELECT);
    if (updateError) {
      if (errorCode(updateError) === "23503") supplierNotOnJob();
      writeFailed("line update", updateError);
    }
    const row = Array.isArray(updated) ? updated[0] : updated;
    if (!row) {
      // The guard held: someone else changed (or removed) the line first.
      const latest = await readLineById(client, input.id);
      if (!latest) {
        throw new DispatchMaterialsError(
          409,
          "line_changed",
          "This line was removed somewhere else",
          { line: null },
        );
      }
      if (latest.purchase_order_id) lineOnOrder(latest);
      lineChanged(latest);
    }
    return {
      success: true,
      line: projectDispatchMaterialLine(row),
      counts: await readJobCounts(client, job.id),
    };
  }

  // An edit to a line that is gone (removed in another tab) never brings it
  // back: only a save with no expected stamp is an insert.
  if (expected !== undefined && expected !== null) {
    throw new DispatchMaterialsError(
      409,
      "line_changed",
      "This line was removed somewhere else",
      { line: null },
    );
  }

  // A new line.
  const chosen = await readChosenSupplier(client, job.id, input.supplier_id);
  if (!chosen) supplierNotOnJob();
  if (
    await countJobLines(client, job.id) >= DISPATCH_MATERIAL_LINES_PER_JOB_MAX
  ) {
    throw new DispatchMaterialsError(
      409,
      "too_many_lines",
      `A job holds at most ${DISPATCH_MATERIAL_LINES_PER_JOB_MAX} lines`,
    );
  }
  const position = await nextPosition(client, "job_material_lines", job.id);
  const { data: inserted, error: insertError } = await client
    .from("job_material_lines")
    .insert({
      id: input.id,
      org_id: job.org_id,
      job_id: job.id,
      supplier_id: input.supplier_id,
      description,
      quantity,
      unit,
      status: status ?? "not_reviewed",
      source: "manual",
      position,
      created_at: now,
      updated_at: now,
      created_by: ctx.actor.userId,
      updated_by: ctx.actor.userId,
      created_by_email: ctx.actor.email,
      updated_by_email: ctx.actor.email,
    })
    .select(DISPATCH_MATERIAL_LINE_SELECT)
    .single();
  if (insertError) {
    if (errorCode(insertError) === "23505") {
      // The same id landed first (a retried save): one row, never two.
      const raced = await readLineById(client, input.id);
      if (raced && String(raced.job_id) !== job.id) lineNotOnJob();
      if (raced) {
        return {
          success: true,
          unchanged: true,
          line: projectDispatchMaterialLine(raced),
          counts: await readJobCounts(client, job.id),
        };
      }
    }
    if (errorCode(insertError) === "23503") supplierNotOnJob();
    writeFailed("line insert", insertError);
  }
  return {
    success: true,
    line: projectDispatchMaterialLine(inserted),
    counts: await readJobCounts(client, job.id),
  };
}

export async function deleteDispatchMaterialLine(
  client: any,
  body: any,
  ctx: DispatchMaterialsContext,
) {
  const job = await loadDispatchJob(client, bodyJobId(body), ctx);
  if (!isDispatchUuid(body?.id)) badRequest("id must be a uuid");
  const expected = body?.expected_updated_at;
  if (typeof expected !== "string" || !expected) {
    badRequest("expected_updated_at required");
  }

  const stored = await readLineById(client, body.id);
  if (!stored) {
    return {
      success: true,
      unchanged: true,
      counts: await readJobCounts(client, job.id),
    };
  }
  if (String(stored.job_id) !== job.id) lineNotOnJob();
  if (stored.purchase_order_id) lineOnOrder(stored);

  const { data: deleted, error: deleteError } = await client
    .from("job_material_lines")
    .delete()
    .eq("id", body.id)
    .eq("job_id", job.id)
    .eq("updated_at", expected)
    .is("purchase_order_id", null)
    .select("id");
  if (deleteError) writeFailed("line delete", deleteError);
  if (!Array.isArray(deleted) || deleted.length === 0) {
    const latest = await readLineById(client, body.id);
    if (!latest) {
      return {
        success: true,
        unchanged: true,
        counts: await readJobCounts(client, job.id),
      };
    }
    if (latest.purchase_order_id) lineOnOrder(latest);
    lineChanged(latest);
  }
  return { success: true, counts: await readJobCounts(client, job.id) };
}

// ── The scope suggestion ────────────────────────────────────────────────────

// A suggested line's id is fixed by its job and place, so two presses that both
// pass the no-lines check insert the same ids and the second clashes on the
// primary key (23505 -> lines_exist) instead of adding every line twice.
async function suggestedLineId(jobId: string, index: number) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`dispatch-scope-line:${jobId}:${index}`),
    ),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export async function suggestDispatchMaterialLines(
  client: any,
  body: any,
  ctx: DispatchMaterialsContext,
) {
  const job = await loadDispatchJob(client, bodyJobId(body), ctx);
  if (job.work_type !== "patio") {
    throw new DispatchMaterialsError(
      409,
      "no_suggestion_for_work_type",
      "Lines are suggested from the scope on patio jobs only",
    );
  }
  const supplierId = body?.supplier_id;
  if (!isDispatchUuid(supplierId)) badRequest("supplier_id must be a uuid");
  const chosen = await readChosenSupplier(client, job.id, supplierId);
  if (!chosen) supplierNotOnJob();
  if (await countJobLines(client, job.id) > 0) {
    throw new DispatchMaterialsError(
      409,
      "lines_exist",
      "This job already has lines",
    );
  }

  // One single-job read of the scope, and never the pricing: with null
  // pricing the extractor's quote-lines fallback cannot run, so a customer's
  // quote line and its price can never become a material line.
  const { data: scopeRow, error: scopeError } = await client.from("jobs")
    .select("id, scope_json")
    .eq("id", job.id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (scopeError) readFailed("scope read", scopeError);
  let items: any[];
  try {
    items = ctx.extractMaterialsFromScope(scopeRow?.scope_json ?? null, null);
  } catch (error) {
    console.error("[dispatch_materials] scope could not be read:", error);
    throw new DispatchMaterialsError(
      409,
      "scope_unreadable",
      "The job's scope could not be read",
    );
  }
  const suggested = dispatchSuggestedLines(items);
  if (suggested.length === 0) {
    return {
      success: true,
      added: 0,
      lines: [],
      counts: await readJobCounts(client, job.id),
    };
  }

  const now = nowIso(ctx);
  const ids = await Promise.all(
    suggested.map((_line, index) => suggestedLineId(job.id, index)),
  );
  const rows = suggested.map((line, index) => ({
    id: ids[index],
    org_id: job.org_id,
    job_id: job.id,
    supplier_id: supplierId,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    status: "not_reviewed",
    source: "scope",
    position: index + 1,
    created_at: now,
    updated_at: now,
    created_by: ctx.actor.userId,
    updated_by: ctx.actor.userId,
    created_by_email: ctx.actor.email,
    updated_by_email: ctx.actor.email,
  }));
  const { data: inserted, error: insertError } = await client
    .from("job_material_lines")
    .insert(rows)
    .select(DISPATCH_MATERIAL_LINE_SELECT);
  if (insertError) {
    if (errorCode(insertError) === "23505") {
      throw new DispatchMaterialsError(
        409,
        "lines_exist",
        "This job already has lines",
      );
    }
    if (errorCode(insertError) === "23503") supplierNotOnJob();
    writeFailed("suggested lines insert", insertError);
  }
  const insertedRows: any[] = Array.isArray(inserted) ? inserted : [];
  insertedRows.sort((a, b) => Number(a.position) - Number(b.position));
  return {
    success: true,
    added: insertedRows.length,
    lines: insertedRows.map(projectDispatchMaterialLine),
    counts: await readJobCounts(client, job.id),
  };
}

// ── Working out and sketch ──────────────────────────────────────────────────

const WORKINGS_FIELDS = {
  working_out: {
    stamp: "working_out_updated_at",
    by: "working_out_updated_by_email",
    expected: "expected_working_out_updated_at",
    clean: cleanDispatchWorkingOut,
  },
  sketch_png: {
    stamp: "sketch_updated_at",
    by: "sketch_updated_by_email",
    expected: "expected_sketch_updated_at",
    clean: cleanDispatchSketch,
  },
} as const;

type WorkingsField = keyof typeof WORKINGS_FIELDS;

export async function saveDispatchWorkings(
  client: any,
  body: any,
  ctx: DispatchMaterialsContext,
) {
  const job = await loadDispatchJob(client, bodyJobId(body), ctx);
  const given = (Object.keys(WORKINGS_FIELDS) as WorkingsField[])
    .filter((name) => body && Object.prototype.hasOwnProperty.call(body, name));
  if (given.length !== 1) {
    badRequest("send exactly one of working_out or sketch_png");
  }
  const field = given[0];
  const spec = WORKINGS_FIELDS[field];
  const value = fieldOrBadRequest(spec.clean(body[field]));
  const expectedRaw = body?.[spec.expected];
  if (
    expectedRaw !== undefined && expectedRaw !== null &&
    (typeof expectedRaw !== "string" || !expectedRaw)
  ) {
    badRequest(`${spec.expected} must be a timestamp or null`);
  }
  const expected: string | null = expectedRaw ?? null;
  // The stored value of the one field (for a 409) and both stamps (for the
  // answer). The sketch itself is never sent back on success.
  const select = `job_id, ${field}, working_out_updated_at, sketch_updated_at`;

  const readStored = async () => {
    const { data, error } = await client.from("job_dispatch_workings")
      .select(select)
      .eq("job_id", job.id)
      .maybeSingle();
    if (error) readFailed("workings read", error);
    return data || null;
  };
  const changed = (row: any): never => {
    throw new DispatchMaterialsError(
      409,
      "workings_changed",
      "This changed somewhere else",
      {
        field,
        [field]: row?.[field] ?? null,
        [spec.stamp]: row?.[spec.stamp] ?? null,
      },
    );
  };
  const answer = async (row: any) => ({
    success: true,
    workings: {
      working_out_updated_at: row?.working_out_updated_at ?? null,
      sketch_updated_at: row?.sketch_updated_at ?? null,
    },
    counts: await readJobCounts(client, job.id),
  });

  const now = nowIso(ctx);
  const stored = await readStored();
  if (!stored) {
    // A job with no row yet: the expected stamp is null.
    if (expected !== null) changed(null);
    const { data: inserted, error: insertError } = await client
      .from("job_dispatch_workings")
      .insert({
        job_id: job.id,
        org_id: job.org_id,
        [field]: value,
        [spec.stamp]: now,
        [spec.by]: ctx.actor.email,
        created_at: now,
        updated_at: now,
      })
      .select(select)
      .single();
    if (insertError) {
      // Another tab made the row first: say so, with what it saved.
      if (errorCode(insertError) === "23505") changed(await readStored());
      writeFailed("workings insert", insertError);
    }
    return await answer(inserted);
  }

  let update = client.from("job_dispatch_workings")
    .update({
      [field]: value,
      [spec.stamp]: now,
      [spec.by]: ctx.actor.email,
      updated_at: now,
    })
    .eq("job_id", job.id);
  update = expected === null
    ? update.is(spec.stamp, null)
    : update.eq(spec.stamp, expected);
  const { data: updated, error: updateError } = await update.select(select);
  if (updateError) writeFailed("workings update", updateError);
  const row = Array.isArray(updated) ? updated[0] : updated;
  if (!row) changed(await readStored());
  return await answer(row);
}

// ── One entry for the action switch ─────────────────────────────────────────

export async function runDispatchMaterialsAction(
  client: any,
  action: string,
  params: { get(name: string): string | null },
  body: any,
  ctx: DispatchMaterialsContext,
) {
  switch (action) {
    case "dispatch_materials":
      return await readDispatchMaterials(client, params, ctx);
    case "dispatch_materials_add_supplier":
      return await addDispatchMaterialSupplier(client, body, ctx);
    case "dispatch_materials_remove_supplier":
      return await removeDispatchMaterialSupplier(client, body, ctx);
    case "dispatch_materials_save_line":
      return await saveDispatchMaterialLine(client, body, ctx);
    case "dispatch_materials_delete_line":
      return await deleteDispatchMaterialLine(client, body, ctx);
    case "dispatch_materials_suggest":
      return await suggestDispatchMaterialLines(client, body, ctx);
    case "dispatch_materials_save_workings":
      return await saveDispatchWorkings(client, body, ctx);
    default:
      throw new DispatchMaterialsError(
        400,
        "unknown_action",
        `Unknown action: ${action}`,
      );
  }
}
