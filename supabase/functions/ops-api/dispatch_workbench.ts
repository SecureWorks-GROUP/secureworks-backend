// deno-lint-ignore-file no-explicit-any
import { resolveDispatchAttachments } from "./dispatch_attachments.ts";
import { isCurrentContextFact } from "./context_visibility.ts";
import {
  formatPoDeliveryNotes,
  parsePoDeliveryAddress,
} from "../_shared/po_reference.ts";
const sourceLimit = 998;
const orderedStatuses = [
  "submitted",
  "authorised",
  "sent",
  "confirmed",
  "delivered",
  "billed",
];
// Dispatch owns human review state, never source ingestion or outbound execution.
export class DispatchError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}
export const emptyState = () => ({
  groups: [],
  requirements: [],
  notes: [],
  drafts: [],
  movements: [],
  communication_links: [],
  allocations: [],
  receipts: [],
  order_drafts: [],
  prepared_order_id: null,
  context_review: null,
  reviewed_source_version: null,
  assessment: null,
} as any);
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function uuid(v: any): string {
  if (typeof v !== "string" || !uuidPattern.test(v)) {
    throw new DispatchError("Invalid UUID");
  }
  return v;
}
function text(v: any, label: string, max = 10000): string {
  if (typeof v !== "string" || !v.trim() || v.length > max) {
    throw new DispatchError(`Invalid ${label}`);
  }
  return v.trim();
}
function quantity(v: any): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new DispatchError("Quantity must be positive");
  }
  return v;
}
function stockQuantity(v: any): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new DispatchError("Stock quantity must be nonnegative");
  }
  return v;
}
function materialDifference(left: number, right: number): number {
  const difference = left - right;
  return Number.isFinite(difference) &&
      Math.abs(difference) <=
        4 * Number.EPSILON * Math.max(Math.abs(left), Math.abs(right))
    ? 0
    : difference;
}
function materialTotal(values: number[]): number {
  let sum = 0, correction = 0;
  for (const value of values) {
    const next = sum + value;
    if (!Number.isFinite(next)) {
      throw new DispatchError("Material total must be finite");
    }
    correction += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  const total = sum + correction;
  if (!Number.isFinite(total)) {
    throw new DispatchError("Material total must be finite");
  }
  return total;
}
function allocatedQuantity(allocations: any[], receipts: any[]): number {
  return materialDifference(
    materialTotal(allocations.map((a: any) => a.quantity)),
    materialTotal(
      receipts.filter((r: any) =>
        allocations.some((a: any) => a.id === r.allocation_id)
      ).map((r: any) => r.damaged_quantity),
    ),
  );
}
function find(rows: any[], id: any): any {
  const r = rows.find((r) => r.id === uuid(id));
  if (!r) throw new DispatchError("Record not found", 404);
  return r;
}
function upsert(rows: any[], row: any) {
  const i = rows.findIndex((r) => r.id === row.id);
  if (i < 0) rows.push(row);
  else rows[i] = row;
}
function emails(v: any, required = false): string[] {
  if (
    !Array.isArray(v) || v.length > 30 || (required && !v.length) ||
    v.some((x) =>
      typeof x !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)
    )
  ) throw new DispatchError("Invalid email recipients");
  return v;
}
function date(v: any): string | null {
  if (v == null || v === "") return null;
  if (
    typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    new Date(v).toISOString().slice(0, 10) !== v
  ) throw new DispatchError("Invalid date");
  return v;
}
export async function hash(value: any): Promise<string> {
  const canonical = (x: any): any =>
    Array.isArray(x)
      ? x.map(canonical)
      : x && typeof x === "object"
      ? Object.fromEntries(
        Object.keys(x).sort().map((k) => [k, canonical(x[k])]),
      )
      : x;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(value))),
  );
  return Array.from(
    new Uint8Array(bytes),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function eligibility(job: any, documents: any[] = []) {
  const evidence = [];
  if (job.accepted_at) {
    evidence.push({ source: "jobs.accepted_at", value: job.accepted_at });
  }
  for (const doc of documents) {
    if (doc.accepted_at && doc.type === "quote" && !doc.superseded_at) {
      evidence.push({
        source: "documents",
        id: doc.id,
        value: doc.accepted_at,
      });
    }
  }
  return { state: evidence.length ? "accepted" : "unresolved", evidence };
}
const physicalRequirement = (r: any) => ({
  description: r.description ?? null,
  unit: r.unit ?? null,
  specification: r.specification ?? null,
});
const allocationSuitable = (a: any, r: any) =>
  !!r.physical_revision && a.requirement_revision === r.physical_revision &&
  a.suitability_status !== "stale" && a.supply_valid !== false;
const suitabilityObligation = (a: any, r: any) => ({
  code: "allocation_suitability",
  allocation_id: a.id,
  requirement_id: r.id,
  owner: r.owner || "Shaun",
  next_action:
    "Confirm this supply suits the current material specification with evidence, or allocate replacement supply",
});
export function assessment(state: any, source: string, now: string) {
  const obligations: any[] = [];
  if (state.reviewed_source_version !== source) {
    obligations.push({
      code: "complete_set_unreviewed",
      owner: "Shaun",
      next_action:
        "Review the complete requirements set against current scope and quote",
    });
  }
  for (const r of state.requirements) {
    const allocations = state.allocations.filter((a: any) =>
      a.requirement_id === r.id
    );
    const verified = allocations.filter((a: any) => allocationSuitable(a, r));
    const allocated = allocatedQuantity(verified, state.receipts);
    const usable = materialTotal(
      state.receipts.filter((x: any) =>
        verified.some((a: any) => a.id === x.allocation_id) &&
        x.location === (r.destination || "site")
      ).map((x: any) => x.usable_quantity),
    );
    const supplyGap = materialDifference(r.quantity, allocated);
    const receiptGap = materialDifference(r.quantity, usable);
    if (supplyGap > 0 || receiptGap > 0) {
      for (
        const a of allocations.filter((a: any) => !allocationSuitable(a, r))
      ) {
        obligations.push(suitabilityObligation(a, r));
      }
    }
    if (
      !r.quantity || !r.unit || !r.specification ||
      r.reviewed_source_version !== source
    ) {
      obligations.push({
        code: "requirement_review",
        requirement_id: r.id,
        owner: "Shaun",
        next_action: "Verify quantity, unit and specification against source",
      });
    }
    if (
      supplyGap < 0 ||
      (supplyGap > 0 &&
        allocations.some((a: any) =>
          a.unit !== r.unit || a.supply_valid === false
        ))
    ) {
      obligations.push({
        code: "supply_reconciliation",
        requirement_id: r.id,
        owner: r.owner || "Shaun",
        next_action:
          "Resolve changed supply, excess or unit mismatch while preserving receipt custody",
      });
    }
    if (r.quantity && supplyGap > 0) {
      obligations.push({
        code: "supply_gap",
        requirement_id: r.id,
        quantity: supplyGap,
        owner: "Shaun",
        next_action: "Allocate verified existing supply or prepare an order",
      });
    }
    if (r.quantity && receiptGap > 0) {
      obligations.push({
        code: "site_receipt_gap",
        requirement_id: r.id,
        quantity: receiptGap,
        owner: "Shaun",
        next_action: "Confirm usable material at site; ordering is not receipt",
      });
    }
  }
  return {
    source_version: source,
    assessed_at: now,
    stale: false,
    ready: obligations.length === 0,
    obligations,
    live_actions_enabled: false,
  };
}
export async function reduceCommand(
  previous: any,
  command: string,
  p: any,
  source: string,
  actor: string,
  now: string,
): Promise<any> {
  const s = { ...emptyState(), ...structuredClone(previous) };
  const mark = { updated_at: now, updated_by: actor };
  for (const r of s.requirements) {
    r.physical_revision = await hash(physicalRequirement(r));
  }
  const group = (id: any) => id == null ? null : find(s.groups, id).id;
  const requirement = (v: any) => ({
    id: uuid(v.id),
    group_id: group(v.group_id),
    description: text(v.description, "description"),
    quantity: v.quantity == null ? null : quantity(v.quantity),
    unit: v.unit ? text(v.unit, "unit", 30) : null,
    specification: v.specification
      ? text(v.specification, "specification")
      : null,
    source_ref: v.source_ref || null,
    phase: v.phase ? text(v.phase, "phase", 120) : "installation",
    destination: v.destination
      ? text(v.destination, "destination", 120)
      : "site",
    needed_by: date(v.needed_by),
    owner: v.owner ? text(v.owner, "owner", 120) : "Shaun",
    reviewed_source_version: null,
    ...mark,
  });
  switch (command) {
    case "group_upsert":
      upsert(s.groups, {
        id: uuid(p.id),
        name: text(p.name, "group name", 120),
        position: Number.isInteger(p.position) ? p.position : 0,
        ...mark,
      });
      break;
    case "group_delete":
      find(s.groups, p.id);
      s.groups = s.groups.filter((r: any) => r.id !== p.id);
      s.requirements.forEach((r: any) => {
        if (r.group_id === p.id) r.group_id = null;
      });
      break;
    case "requirement_upsert":
    case "requirement_reconcile": {
      const old = s.requirements.find((r: any) => r.id === p.id);
      const updated = {
        ...requirement({ ...old, ...p }),
        physical_revision: "",
      };
      updated.physical_revision = await hash(physicalRequirement(updated));
      const physicalChanged = old &&
        ["quantity", "unit", "specification", "description"].some((k) =>
          k === "quantity"
            ? materialDifference(old[k], (updated as any)[k]) !== 0
            : old[k] !== (updated as any)[k]
        );
      if (
        physicalChanged &&
        s.allocations.some((a: any) => a.requirement_id === p.id) &&
        command !== "requirement_reconcile"
      ) {
        throw new DispatchError(
          "Use explicit reconciliation with a reason when supplied scope changes",
        );
      }
      if (command === "requirement_reconcile") {
        text(p.reason, "reconciliation reason");
      }
      upsert(s.requirements, {
        ...updated,
        revisions: [
          ...(old?.revisions || []),
          ...(old
            ? [{
              previous: { ...old, revisions: undefined },
              reason: p.reason || "Requirement metadata updated",
              ...mark,
            }]
            : []),
        ],
      });
      s.reviewed_source_version = null;
      break;
    }
    case "context_review":
      s.context_review = { source_version: source, actor, at: now };
      break;
    case "requirement_move":
      find(s.requirements, p.id).group_id = group(p.group_id);
      break;
    case "requirement_review": {
      const r = find(s.requirements, p.id);
      if (!r.quantity || !r.unit || !r.specification) {
        throw new DispatchError("Quantity, unit and specification required");
      }
      r.reviewed_source_version = source;
      r.reviewed_by = actor;
      break;
    }
    case "set_review":
      if (
        !s.requirements.length ||
        s.requirements.some((r: any) => r.reviewed_source_version !== source)
      ) {
        throw new DispatchError(
          "Review every requirement in a nonempty set first",
        );
      }
      s.reviewed_source_version = source;
      break;
    case "note_upsert":
      upsert(s.notes, { id: uuid(p.id), text: text(p.text, "note"), ...mark });
      break;
    case "note_promote": {
      const n = find(s.notes, p.id);
      if (n.promoted_requirement_id) {
        throw new DispatchError("Note already promoted");
      }
      const r = requirement(p.requirement);
      if (s.requirements.some((x: any) => x.id === r.id)) {
        throw new DispatchError("Requirement already exists");
      }
      s.requirements.push({
        ...r,
        source_ref: { kind: "dispatch_note", id: n.id },
      });
      n.promoted_requirement_id = r.id;
      s.reviewed_source_version = null;
      break;
    }
    case "order_prepare": {
      if (p.existing_supply_reviewed !== true) {
        throw new DispatchError(
          "Review existing orders and supply before preparing another order",
        );
      }
      if (!Array.isArray(p.requirement_ids) || !p.requirement_ids.length) {
        throw new DispatchError("Select reviewed requirements");
      }
      const lines = [...new Set(p.requirement_ids)].map((id: any) => {
        const r = find(s.requirements, id);
        if (
          r.reviewed_source_version !== source || !r.quantity || !r.unit ||
          !r.specification
        ) {
          throw new DispatchError(
            "Selected requirement needs current source review",
          );
        }
        const price = p.unit_prices?.[id] ?? null;
        if (
          price !== null &&
          (typeof price !== "number" || !Number.isFinite(price) || price < 0)
        ) throw new DispatchError("Invalid price");
        const allocations = s.allocations.filter((a: any) =>
          a.requirement_id === r.id && allocationSuitable(a, r)
        );
        const allocated = allocatedQuantity(allocations, s.receipts);
        const prepared = materialTotal(
          s.order_drafts.filter((o: any) =>
            o.id !== p.id && ["draft", ...orderedStatuses].includes(o.status)
          ).flatMap((o: any) =>
            o.line_items.filter((l: any) =>
              l.dispatch_requirement_id === r.id &&
              JSON.stringify(physicalRequirement(l)) ===
                JSON.stringify(physicalRequirement(r))
            ).map((l: any) =>
              Math.max(
                0,
                materialDifference(
                  Number(l.quantity),
                  Number(l.reserved_quantity || 0),
                ),
              )
            )
          ),
        );
        const uncovered = Math.max(
          0,
          materialDifference(r.quantity, materialTotal([allocated, prepared])),
        );
        const orderedQuantity = quantity(p.quantities?.[id] ?? uncovered);
        if (materialDifference(orderedQuantity, uncovered) > 0) {
          throw new DispatchError(
            "Order quantity exceeds uncovered reviewed requirement",
            409,
          );
        }
        return {
          dispatch_requirement_id: r.id,
          description: r.description,
          specification: r.specification,
          quantity: orderedQuantity,
          unit: r.unit,
          unit_price: price,
        };
      });
      upsert(s.order_drafts, {
        id: uuid(p.id),
        supplier_name: text(p.supplier_name, "supplier", 200),
        xero_contact_id: p.xero_contact_id || null,
        delivery_date: date(p.delivery_date),
        delivery_address: text(p.delivery_address, "delivery address"),
        po_notes: formatPoDeliveryNotes(
          text(p.delivery_address, "delivery address"),
          p.notes,
        ),
        line_items: lines,
        notes: p.notes || "",
        incomplete: lines.some((l: any) => l.unit_price === null),
        source_version: source,
        status: "draft",
        ...mark,
      });
      s.prepared_order_id = p.id;
      break;
    }
    case "draft_upsert": {
      const attachments = p.attachments || [];
      if (!Array.isArray(attachments) || attachments.length > 25) {
        throw new DispatchError("Invalid attachments");
      }
      const d = {
        id: uuid(p.id),
        sender: emails([p.sender], true)[0],
        to: emails(p.to, true),
        cc: emails(p.cc || []),
        subject: text(p.subject, "subject", 500),
        body: text(p.body, "body", 100000),
        attachments: attachments.map((a: any) => ({
          id: text(a.id, "attachment id"),
          name: text(a.name, "attachment name"),
          source_ref: text(a.source_ref, "attachment source"),
          revision: text(a.revision, "attachment revision"),
        })),
        po_id: p.po_id ? uuid(p.po_id) : null,
        purchase_commitment: !!p.po_id || p.purchase_commitment !== false,
        thread_id: p.thread_id || null,
        graph_message_id: p.graph_message_id
          ? text(p.graph_message_id, "native message id")
          : null,
        graph_change_key: p.graph_message_id
          ? text(p.graph_change_key, "native source revision")
          : null,
        graph_link_reason: p.graph_message_id
          ? text(p.graph_link_reason, "explicit job association reason")
          : null,
        reply_all: p.reply_all === true,
        proposed_delivery_at: p.proposed_delivery_at || null,
        source_version: source,
        status: "draft",
        ...mark,
      };
      upsert(s.drafts, { ...d, content_hash: await hash(d) });
      break;
    }
    case "draft_revoke": {
      const d = find(s.drafts, p.id);
      d.approval = null;
      d.revocation = {
        actor,
        at: now,
        reason: text(p.reason, "revocation reason"),
      };
      break;
    }
    case "draft_approve": {
      const d = find(s.drafts, p.id);
      if (
        d.source_version !== source ||
        d.review?.content_hash !== d.content_hash ||
        d.review?.source_version !== source || p.content_hash !== d.content_hash
      ) {
        throw new DispatchError(
          "Review exact current draft before approval",
          409,
        );
      }
      if (
        p.communications_approved !== true ||
        ((d.po_id || d.purchase_commitment !== false) &&
          p.purchase_approved !== true)
      ) {
        throw new DispatchError(
          "Communications and supplier commitment approvals are separate",
          403,
        );
      }
      d.approval = {
        id: uuid(p.approval_id),
        actor,
        at: now,
        content_hash: d.content_hash,
        source_version: source,
        communications_approved: true,
        purchase_approved: p.purchase_approved === true,
      };
      break;
    }
    case "draft_review": {
      const d = find(s.drafts, p.id);
      if (d.source_version !== source) {
        throw new DispatchError(
          "Draft source changed; re-save exact draft before review",
          409,
        );
      }
      d.status = "reviewed";
      d.review = {
        content_hash: d.content_hash,
        source_version: source,
        actor,
        at: now,
      };
      break;
    }
    case "movement_upsert": {
      const ids = p.requirement_ids || [];
      if (!Array.isArray(ids)) throw new DispatchError("Invalid requirements");
      ids.forEach((id: any) => find(s.requirements, id));
      if (p.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)) {
        throw new DispatchError("Invalid time");
      }
      upsert(s.movements, {
        id: uuid(p.id),
        title: text(p.title, "movement title"),
        from_location: text(p.from_location, "origin"),
        to_location: text(p.to_location, "destination"),
        date: date(p.date),
        time: p.time || null,
        requirement_ids: ids,
        status: "proposed",
        source_version: source,
        ...mark,
      });
      break;
    }
    case "stock_record":
      uuid(p.id);
      text(p.description, "stock description");
      stockQuantity(p.quantity);
      text(p.unit, "unit");
      text(p.location, "stock location");
      text(p.evidence, "stock count evidence");
      break;
    case "allocation_upsert": {
      const r = find(s.requirements, p.requirement_id);
      const q = quantity(p.quantity);
      const siblings = s.allocations.filter((a: any) =>
        a.requirement_id === r.id && a.id !== p.id && allocationSuitable(a, r)
      );
      const others = allocatedQuantity(siblings, s.receipts);
      if (
        !r.quantity ||
        materialDifference(materialTotal([q, others]), r.quantity) > 0
      ) {
        throw new DispatchError("Allocation exceeds required quantity");
      }
      if (s.receipts.some((x: any) => x.allocation_id === p.id)) {
        throw new DispatchError("Receipted allocation is immutable");
      }
      upsert(s.allocations, {
        id: uuid(p.id),
        requirement_id: r.id,
        supply_id: text(p.supply_id, "supply reference"),
        quantity: q,
        unit: r.unit,
        requirement_revision: r.physical_revision,
        suitability_status: "current",
        ...mark,
      });
      break;
    }
    case "allocation_confirm_suitability": {
      const a = find(s.allocations, uuid(p.id));
      const r = find(s.requirements, a.requirement_id);
      if (
        a.supply_valid !== true || !a.current_supply_revision ||
        a.unit !== r.unit ||
        (a.supply_revision && a.supply_revision !== a.current_supply_revision)
      ) {
        throw new DispatchError(
          "Current verified supply is required for suitability confirmation",
          409,
        );
      }
      a.requirement_revision = r.physical_revision;
      a.supply_revision = a.current_supply_revision;
      a.suitability_status = "current";
      a.suitability_obligation = null;
      a.suitability_confirmation = {
        reason: text(p.reason, "suitability reason"),
        evidence: text(p.evidence, "suitability evidence"),
        requirement_revision: r.physical_revision,
        supply_revision: a.current_supply_revision,
        source_version: source,
        actor,
        at: now,
      };
      break;
    }
    case "allocation_delete":
      if (s.receipts.some((x: any) => x.allocation_id === p.id)) {
        throw new DispatchError("Receipted allocation cannot be removed");
      }
      find(s.allocations, p.id);
      s.allocations = s.allocations.filter((a: any) => a.id !== p.id);
      break;
    case "receipt_upsert": {
      const previousReceipt = s.receipts.find((r: any) => r.id === uuid(p.id));
      if (
        previousReceipt && previousReceipt.allocation_id !== p.allocation_id
      ) {
        throw new DispatchError("Receipt allocation is immutable", 409);
      }
      if (previousReceipt && previousReceipt.location !== p.location) {
        throw new DispatchError(
          "Use receipt transfer to change custody location",
          409,
        );
      }
      const a = find(s.allocations, p.allocation_id);
      const usable = Number(p.usable_quantity),
        damaged = Number(p.damaged_quantity || 0);
      if (
        !Number.isFinite(usable) || !Number.isFinite(damaged) || usable < 0 ||
        damaged < 0 || usable + damaged <= 0
      ) throw new DispatchError("Invalid receipt quantities");
      const others = materialTotal(
        s.receipts.filter((x: any) => x.allocation_id === a.id && x.id !== p.id)
          .flatMap((x: any) => [x.usable_quantity, x.damaged_quantity]),
      );
      if (
        materialDifference(
          materialTotal([others, usable, damaged]),
          a.quantity,
        ) > 0
      ) {
        throw new DispatchError("Receipts exceed allocation");
      }
      upsert(s.receipts, {
        ...previousReceipt,
        id: uuid(p.id),
        allocation_id: a.id,
        usable_quantity: usable,
        damaged_quantity: damaged,
        location: text(p.location, "location"),
        evidence: text(p.evidence, "receipt evidence"),
        ...mark,
      });
      break;
    }
    case "receipt_transfer": {
      const r = find(s.receipts, p.id),
        destination = text(p.location, "destination"),
        evidence = text(p.evidence, "transfer evidence");
      if (p.quantity !== undefined) {
        const moved = quantity(p.quantity);
        const remaining = materialDifference(r.usable_quantity, moved);
        if (remaining < 0) {
          throw new DispatchError("Transfer exceeds usable receipt quantity");
        }
        if (remaining > 0 || r.damaged_quantity > 0) {
          const newId = uuid(p.new_id);
          if (s.receipts.some((x: any) => x.id === newId)) {
            throw new DispatchError("Split receipt ID already exists");
          }
          r.usable_quantity = remaining;
          s.receipts.push({
            ...r,
            id: newId,
            usable_quantity: moved,
            damaged_quantity: 0,
            location: destination,
            split_from: r.id,
            transfers: [...(r.transfers || []), {
              from_location: r.location,
              to_location: destination,
              quantity: moved,
              evidence,
              ...mark,
            }],
            ...mark,
          });
          break;
        }
        r.usable_quantity = moved;
      }
      r.transfers = [...(r.transfers || []), {
        from_location: r.location,
        to_location: destination,
        quantity: r.usable_quantity,
        evidence,
        ...mark,
      }];
      r.location = destination;
      break;
    }
    case "communication_link":
      upsert(s.communication_links, {
        id: uuid(p.id),
        communication_id: uuid(p.communication_id),
        source_job_id: uuid(p.source_job_id),
        reason: text(p.reason, "link reason"),
        ...mark,
      });
      break;
    case "assess":
      s.assessment = assessment(s, source, now);
      return s;
    default:
      throw new DispatchError(
        "Unsupported command; live sends, purchases and execution are disabled",
        403,
      );
  }
  if (s.assessment) s.assessment.stale = true;
  return s;
}
const checked = (r: any): any => {
  if (r.error) {
    throw new DispatchError(r.error.message || "Database read failed", 503);
  }
  return r.data;
};
async function rows(client: any, table: string, org: string, job: string) {
  return checked(
    await client.from(table).select("*, jobs!inner(org_id)").eq(
      "jobs.org_id",
      org,
    ).eq("job_id", job).order("id").limit(sourceLimit + 1),
  ) || [];
}
async function referencedRows(
  client: any,
  table: string,
  org: string,
  ids: string[],
) {
  const unique = [...new Set(ids)], result: any[] = [];
  for (let start = 0; start < unique.length; start += 100) {
    result.push(
      ...(checked(
        await client.from(table).select("*").eq("org_id", org)
          .in("id", unique.slice(start, start + 100)).limit(101),
      ) || []),
    );
  }
  return result;
}
export async function readDispatchJob(client: any, org: string, jobId: string) {
  uuid(jobId);
  const beforeVersion = checked(
    await client.rpc("dispatch_source_version", { p_org: org, p_job: jobId }),
  );
  const job = checked(
    await client.from("jobs").select("*").eq("org_id", org).eq("id", jobId)
      .maybeSingle(),
  );
  if (!job) throw new DispatchError("Job not found", 404);
  const [planResult, po, documents, communications, media] = await Promise.all([
    client.from("dispatch_plans").select("*").eq("org_id", org).eq(
      "job_id",
      jobId,
    ).maybeSingle(),
    rows(client, "purchase_orders", org, jobId),
    rows(client, "job_documents", org, jobId),
    rows(client, "po_communications", org, jobId),
    rows(client, "job_media", org, jobId),
  ]);
  const plan = checked(planResult);
  const state = { ...emptyState(), ...structuredClone(plan?.state) };
  for (const r of state.requirements) {
    r.physical_revision = await hash(physicalRequirement(r));
  }
  const allocatedLots = await referencedRows(
    client,
    "dispatch_supply_lots",
    org,
    state.allocations.map((a: any) => a.supply_id),
  );
  const referencedPo = await referencedRows(
    client,
    "purchase_orders",
    org,
    allocatedLots.filter((lot: any) =>
      lot.source_ref?.kind === "purchase_order_line"
    )
      .map((lot: any) => lot.source_ref.po_id),
  );
  for (const allocation of state.allocations) {
    const lot = allocatedLots.find((l: any) => l.id === allocation.supply_id);
    let valid = !!lot && lot.unit === allocation.unit &&
      Number.isFinite(Number(lot.quantity)) &&
      materialDifference(Number(lot.quantity), allocation.quantity) >= 0;
    if (lot?.source_ref?.kind === "purchase_order_line") {
      const p = referencedPo.find((p: any) => p.id === lot.source_ref.po_id);
      const line = p?.line_items?.[lot.source_ref.index];
      valid = valid && !!p && orderedStatuses.includes(p.status) && !!line &&
        line.unit === allocation.unit &&
        materialDifference(Number(line.quantity), allocation.quantity) >= 0 &&
        await hash(line) === lot.source_version &&
        await hash(p.line_items) === await hash(lot.source_ref.po_lines);
    } else if (lot?.source_ref?.kind !== "stock_count") valid = false;
    if (
      allocation.supply_revision &&
      allocation.supply_revision !== lot?.source_version
    ) valid = false;
    allocation.supply_valid = valid;
    allocation.current_supply_revision = lot?.source_version || null;
    const r = state.requirements.find((r: any) =>
      r.id === allocation.requirement_id
    );
    allocation.suitability_status =
      valid && !!r && allocation.unit === r.unit &&
        allocation.requirement_revision === r.physical_revision &&
        allocation.supply_revision === lot?.source_version
        ? "current"
        : "stale";
    allocation.suitability_obligation =
      allocation.suitability_status === "current" || !r
        ? null
        : suitabilityObligation(allocation, r);
  }
  const orderReservations = checked(
    await client.rpc("dispatch_order_reservations", {
      p_org: org,
      p_job: jobId,
    }),
  ) || [];
  state.order_drafts = state.order_drafts.map((draft: any) => {
    const current = po.find((p: any) => p.id === draft.id && p.org_id === org);
    return {
      ...draft,
      status: current?.status || "missing",
      line_items: Array.isArray(current?.line_items)
        ? current.line_items.map((line: any, index: number) => ({
          ...line,
          reserved_quantity: Number(
            orderReservations.find((r: any) =>
              r.supply_id === `po:${current.id}:${index}`
            )?.reserved_quantity || 0,
          ),
        }))
        : [],
      delivery_address: current ? parsePoDeliveryAddress(current.notes) : null,
    };
  });
  const sourceVersion = checked(
    await client.rpc("dispatch_source_version", { p_org: org, p_job: jobId }),
  );
  if (!sourceVersion) {
    throw new DispatchError("Source revision unavailable", 503);
  }
  const [contextResult, upstreamResult] = await Promise.all([
    client.from("current_job_context_facts").select("*").eq("job_id", jobId)
      .order("id").limit(sourceLimit + 1),
    client.rpc("dispatch_context_facts_for_source", {
      p_org: org,
      p_job: jobId,
      p_limit: sourceLimit + 1,
    }),
  ]);
  const contextRows = contextResult.error
    ? []
    : (contextResult.data || []).filter((r: any) => isCurrentContextFact(r));
  const supplyLots = [];
  for (
    const p of po.slice(0, sourceLimit).filter((p: any) =>
      orderedStatuses.includes(p.status)
    )
  ) {
    for (
      const [index, line] of (Array.isArray(p.line_items) ? p.line_items : [])
        .entries()
    ) {
      const revision = await hash(line);
      supplyLots.push({
        id: `po:${p.id}:${index}`,
        quantity: Number(line.quantity),
        unit: line.unit || null,
        description: line.description,
        source_ref: { kind: "purchase_order_line", po_id: p.id, index },
        source_version: revision,
      });
    }
  }
  const afterVersion = checked(
    await client.rpc("dispatch_source_version", { p_org: org, p_job: jobId }),
  );
  if (beforeVersion !== sourceVersion || sourceVersion !== afterVersion) {
    throw new DispatchError("Sources changed during read; retry", 409);
  }
  const complete = po.length <= sourceLimit &&
    documents.length <= sourceLimit &&
    communications.length <= sourceLimit && media.length <= sourceLimit;
  return {
    job: { ...job, eligibility: eligibility(job, documents) },
    version: plan?.version || 0,
    source_version: sourceVersion,
    ...state,
    assessment: state.assessment
      ? {
        ...state.assessment,
        stale: state.assessment.stale ||
          state.assessment.source_version !== sourceVersion,
      }
      : null,
    purchase_orders: po.slice(0, sourceLimit).map((p: any) => ({
      ...p,
      delivery_address: parsePoDeliveryAddress(p.notes),
    })),
    documents: documents.slice(0, sourceLimit),
    communications: communications.slice(0, sourceLimit),
    media: media.slice(0, sourceLimit),
    supply_lots: supplyLots,
    context_facts: contextRows.slice(0, sourceLimit),
    upstream_context_facts: upstreamResult.error
      ? []
      : (upstreamResult.data || [])
        .filter((r: any) => isCurrentContextFact(r)).slice(0, sourceLimit),
    coverage: {
      complete,
      purchase_orders: po.length,
      documents: documents.length,
      communications: communications.length,
      context: {
        available: !contextResult.error && !upstreamResult.error,
        complete: !contextResult.error && !upstreamResult.error &&
          (contextResult.data || []).length <= sourceLimit &&
          (upstreamResult.data || []).length <= sourceLimit,
        source: "current_job_context_facts",
        reason: contextResult.error || upstreamResult.error
          ? "Current context source read failed"
          : null,
      },
    },
    live_actions_enabled: false,
  };
}
export async function dispatchCommand(
  client: any,
  org: string,
  actor: string,
  b: any,
  task: any = null,
) {
  uuid(b.job_id);
  uuid(b.request_id);
  if (!Number.isSafeInteger(b.expected_version) || b.expected_version < 0) {
    throw new DispatchError("Invalid expected version");
  }
  const requestHash = await hash(b);
  const prior = checked(
    await client.from("dispatch_commands").select("*").eq("org_id", org).eq(
      "request_id",
      b.request_id,
    ).maybeSingle(),
  );
  if (prior) {
    if (prior.request_hash !== requestHash || prior.job_id !== b.job_id) {
      throw new DispatchError("Idempotency conflict", 409);
    }
    return readDispatchJob(client, org, b.job_id);
  }
  const current = await readDispatchJob(client, org, b.job_id);
  if (
    current.version !== b.expected_version ||
    current.source_version !== b.source_version
  ) {
    throw new DispatchError(
      "Source or plan changed; reload before saving",
      409,
    );
  }
  if (!current.coverage.complete) {
    throw new DispatchError("Source coverage incomplete", 409);
  }
  const state = Object.fromEntries(
    Object.keys(emptyState()).map(
      (k) => [k, current[k as keyof typeof current]],
    ),
  );
  if (
    ["assess", "context_review"].includes(b.command) &&
    (!current.coverage.context.available || !current.coverage.context.complete)
  ) throw new DispatchError("Current context coverage incomplete", 409);
  if (b.command === "communication_link") {
    const linked = checked(
      await client.from("po_communications").select(
        "id,job_id,jobs!inner(org_id)",
      ).eq("id", uuid(b.payload.communication_id)).eq("jobs.org_id", org)
        .maybeSingle(),
    );
    if (!linked || linked.job_id !== b.payload.source_job_id) {
      throw new DispatchError("Communication source identity mismatch", 409);
    }
  }
  if (
    b.command === "draft_upsert" && b.payload.po_id &&
    !current.purchase_orders.some((p: any) => p.id === b.payload.po_id)
  ) throw new DispatchError("Draft PO does not belong to this job", 409);
  if (
    b.command === "draft_upsert" && b.payload.thread_id &&
    !b.payload.graph_message_id &&
    !current.communications.some((c: any) =>
      c.thread_id === b.payload.thread_id
    )
  ) {
    throw new DispatchError(
      "Reply thread is not an authoritative current-job conversation; use an explicit new conversation",
      409,
    );
  }
  if (b.command === "draft_upsert") {
    b = {
      ...b,
      payload: {
        ...b.payload,
        attachments: await resolveDispatchAttachments(
          b.payload.attachments || [],
          current.documents,
          current.media,
        ),
      },
    };
  }
  const next = await reduceCommand(
    state,
    b.command,
    b.payload || {},
    current.source_version,
    actor,
    new Date().toISOString(),
  );
  const lots = [];
  if (b.command === "stock_record") {
    lots.push({
      id: `stock:${b.payload.id}`,
      quantity: b.payload.quantity,
      unit: b.payload.unit,
      source_version: await hash(b.payload),
      source_ref: {
        kind: "stock_count",
        description: b.payload.description,
        location: b.payload.location,
        evidence: b.payload.evidence,
        actor,
        counted_at: new Date().toISOString(),
      },
    });
  }
  if (b.command === "allocation_upsert") {
    const supply = String(b.payload.supply_id || "");
    const allocation = find(next.allocations, b.payload.id);
    if (supply.startsWith("stock:")) {
      const lot = checked(
        await client.from("dispatch_supply_lots").select("*").eq("org_id", org)
          .eq("id", supply).maybeSingle(),
      );
      if (!lot || lot.source_ref?.kind !== "stock_count") {
        throw new DispatchError("Counted stock source not found");
      }
      allocation.supply_revision = lot.source_version;
    } else {
      const match = /^po:([0-9a-f-]{36}):(0|[1-9]\d*)$/.exec(supply);
      if (!match) throw new DispatchError("Invalid PO supply identity");
      if (!Number.isSafeInteger(Number(match[2]))) {
        throw new DispatchError("Invalid PO line index");
      }
      const po = checked(
        await client.from("purchase_orders").select("*").eq("org_id", org).eq(
          "id",
          uuid(match[1]),
        ).maybeSingle(),
      );
      if (
        !po ||
        !["submitted", "authorised", "sent", "confirmed", "delivered", "billed"]
          .includes(po.status)
      ) {
        throw new DispatchError("Supply PO is not ordered");
      }
      const index = Number(match[2]), line = po.line_items?.[index];
      if (supply !== `po:${po.id}:${index}`) {
        throw new DispatchError("Invalid PO supply identity");
      }
      if (!line) throw new DispatchError("Supply line missing");
      if (!line.unit) {
        throw new DispatchError(
          "PO line has no verified physical unit; review material specification instead of treating a lump-sum line as stock",
        );
      }
      allocation.supply_revision = await hash(line);
      lots.push({
        id: supply,
        quantity: Number(line.quantity),
        unit: line.unit || null,
        source_ref: {
          kind: "purchase_order_line",
          po_id: po.id,
          index,
          job_id: po.job_id,
          po_lines: po.line_items,
        },
        source_version: allocation.supply_revision,
        source_snapshot: line,
      });
    }
  }
  if (b.command === "assess") {
    next.assessment.context_facts = current.upstream_context_facts.map((
      f: any,
    ) => ({
      id: f.id,
      kind: f.kind,
      value: f.value,
      source_ref: { table: f._context_store, id: f.id },
    }));
    next.assessment.context_review_required =
      current.upstream_context_facts.length > 0 &&
      next.context_review?.source_version !== current.source_version;
    if (next.assessment.context_review_required) {
      next.assessment.ready = false;
      next.assessment.obligations.push({
        code: "context_constraints_review",
        owner: "Shaun",
        next_action:
          "Review current job instructions and conditions before materials release",
      });
    }
  }
  const result = await client.rpc("dispatch_commit", {
    p_org: org,
    p_job: b.job_id,
    p_expected: b.expected_version,
    p_request: b.request_id,
    p_hash: requestHash,
    p_actor: actor,
    p_command: b.command,
    p_source: current.source_version,
    p_state: next,
    p_lots: lots,
    p_task: task,
  });
  if (result.error) {
    throw new DispatchError(
      result.error.message,
      result.error.code === "40001" ? 409 : 503,
    );
  }
  return readDispatchJob(client, org, b.job_id);
}
export async function dispatchList(
  client: any,
  org: string,
  params: URLSearchParams,
) {
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") || 50)));
  if (!Number.isInteger(limit)) throw new DispatchError("Invalid limit");
  let q = client.from("dispatch_eligible_jobs").select(
    "id,job_number,client_name,site_address,type,status,accepted_at,dispatch_eligibility",
  ).eq("org_id", org).order("id").limit(limit + 1);
  if (params.get("cursor")) q = q.gt("id", uuid(params.get("cursor")));
  const data = checked(await q) || [];
  const more = data.length > limit;
  return {
    jobs: data.slice(0, limit).map((j: any) => ({
      ...j,
      work_type: j.type,
      stage: j.status,
      eligibility: {
        state: j.dispatch_eligibility,
        evidence: j.accepted_at
          ? [{ source: "jobs.accepted_at", value: j.accepted_at }]
          : [],
      },
      next_action: j.dispatch_eligibility === "unresolved"
        ? "Resolve acceptance evidence"
        : "Review material obligations",
    })),
    next_cursor: more ? data[limit - 1].id : null,
    coverage: {
      complete: !more,
      has_more: more,
      source: "jobs + accepted job_documents",
      eligibility_policy:
        "Explicit acceptance or accepted quote; unresolved post-acceptance-stage candidates retained; archived/cancelled/deleted excluded",
    },
  };
}
export async function dispatchCommunications(
  client: any,
  org: string,
  params: URLSearchParams,
) {
  const scope = params.get("scope") || "job";
  if (!["job", "all"].includes(scope)) {
    throw new DispatchError("Invalid search scope");
  }
  let q = client.from("po_communications").select(
    "*,jobs!inner(id,org_id,job_number,client_name)",
  ).eq("jobs.org_id", org).order("id").limit(51);
  if (scope === "job") q = q.eq("job_id", uuid(params.get("job_id")));
  if (params.get("cursor")) q = q.gt("id", uuid(params.get("cursor")));
  const search = params.get("search") || "";
  if (search) {
    if (search.length > 200 || /[,%()]/.test(search)) {
      throw new DispatchError("Search excludes filter metacharacters");
    }
    q = q.or(
      `subject.ilike.*${search}*,body_text.ilike.*${search}*,from_email.ilike.*${search}*`,
    );
  }
  const data = checked(await q) || [];
  const more = data.length > 50;
  return {
    records: data.slice(0, 50).map((r: any) => ({
      ...r,
      source: "po_communications",
      source_job_id: r.job_id,
      source_ref: {
        table: "po_communications",
        id: r.id,
        message_id: r.message_id || null,
        thread_id: r.thread_id || null,
      },
    })),
    next_cursor: more ? data[49].id : null,
    coverage: {
      complete: !more,
      has_more: more,
      source: "Captured linked job/PO communications only",
      scope,
      outlook: {
        available: false,
        reason:
          "Mailbox retrieval adapter not yet connected; captured mail is not complete Outlook history",
      },
    },
  };
}
export async function dispatchCalendar(
  client: any,
  org: string,
  params: URLSearchParams,
) {
  const from = date(params.get("from")), to = date(params.get("to"));
  if (!from || !to || from > to) {
    throw new DispatchError("Valid from/to dates required");
  }
  const [plans, po, staff] = await Promise.all([
    client.from("dispatch_plans").select("job_id,state").eq("org_id", org)
      .order("job_id").limit(sourceLimit + 1),
    client.from("purchase_orders").select("*,jobs!inner(org_id,job_number)").eq(
      "jobs.org_id",
      org,
    ).neq("status", "deleted").order("id").limit(sourceLimit + 1),
    client.from("calendar_events").select(
      "assignment_id,job_id,job_number,user_id,scheduled_date,scheduled_end,start_time,end_time,crew_name,assignment_status,org_id",
    ).eq("org_id", org).neq("assignment_status", "cancelled").lte(
      "scheduled_date",
      to,
    ).or(
      `scheduled_end.gte.${from},and(scheduled_end.is.null,scheduled_date.gte.${from})`,
    ).order("assignment_id").limit(sourceLimit + 1),
  ]);
  const planRows = checked(plans) || [],
    poRows = checked(po) || [],
    staffRows = checked(staff) || [];
  const events: any[] = [], undated: any[] = [];
  const add = (e: any) => {
    if (!e.date) undated.push(e);
    else if (e.date <= to && (e.end_date || e.date) >= from) events.push(e);
  };
  for (const p of planRows.slice(0, sourceLimit)) {
    for (const m of p.state.movements || []) {
      add({
        ...m,
        id: `dispatch:${m.id}`,
        job_id: p.job_id,
        layer: "logistics",
        source_ref: {
          table: "dispatch_plans",
          job_id: p.job_id,
          movement_id: m.id,
        },
      });
    }
  }
  for (const p of poRows.slice(0, sourceLimit)) {
    add({
      id: `po:${p.id}`,
      job_id: p.job_id,
      job_number: p.jobs.job_number,
      title: p.supplier_name || "Material delivery",
      date: p.confirmed_delivery_date || p.delivery_date || null,
      layer: "materials",
      status: p.status,
      source_ref: { table: "purchase_orders", id: p.id },
    });
  }
  for (const a of staffRows.slice(0, sourceLimit)) {
    add({
      id: `assignment:${a.assignment_id}`,
      job_id: a.job_id,
      job_number: a.job_number,
      user_id: a.user_id,
      title: a.crew_name || "Crew commitment",
      date: a.scheduled_date,
      end_date: a.scheduled_end,
      time: a.start_time || null,
      end_time: a.end_time,
      layer: "staff",
      status: a.assignment_status,
      source_ref: { table: "job_assignments", id: a.assignment_id },
    });
  }
  return {
    events,
    undated,
    coverage: {
      complete: planRows.length <= sourceLimit &&
        poRows.length <= sourceLimit &&
        staffRows.length <= sourceLimit,
      limit_per_source: sourceLimit,
      source:
        "Existing PO/assignment identities plus proposed Dispatch movements",
    },
    live_actions_enabled: false,
  };
}
// A bounded durable trigger/worker. Repeated triggers deduplicate by source hash;
// crashed leases can be reclaimed; failure leaves retry evidence instead of success.
export async function dispatchTrigger(client: any, org: string, body: any) {
  if (body.job_ids === undefined) {
    const limit = body.limit ?? 25;
    if (!Number.isInteger(limit) || limit < 1 || limit > 25) {
      throw new DispatchError("Reconciliation limit must be between 1 and 25");
    }
    return checked(
      await client.rpc("dispatch_reconcile_eligible_jobs", {
        p_org: org,
        p_limit: limit,
      }),
    );
  }
  if (!Array.isArray(body.job_ids) || body.job_ids.length > 25) {
    throw new DispatchError("Provide up to 25 job IDs");
  }
  const queued = [];
  for (const id of body.job_ids) {
    queued.push(checked(
      await client.rpc("dispatch_enqueue_job", {
        p_org: org,
        p_job: uuid(id),
        p_reason: "manual",
      }),
    ));
  }
  return { queued, live_actions_enabled: false };
}
export async function dispatchRun(client: any, org: string, actor: string) {
  const tasks = checked(
    await client.rpc("dispatch_claim_tasks", { p_org: org, p_limit: 10 }),
  ) || [];
  const results = [];
  for (const task of tasks) {
    try {
      const j = await readDispatchJob(client, org, task.job_id);
      let result;
      if (
        j.source_version !== task.source_version ||
        j.version !== task.plan_version
      ) {
        const replacement = await dispatchTrigger(client, org, {
          job_ids: [task.job_id],
        });
        result = { status: "superseded", replacement: replacement.queued };
      } else {
        const assessed = await dispatchCommand(client, org, actor, {
          job_id: j.job.id,
          expected_version: j.version,
          source_version: j.source_version,
          request_id: crypto.randomUUID(),
          command: "assess",
          payload: {},
        }, task);
        result = {
          status: "assessed",
          version: assessed.version,
          assessment: assessed.assessment,
        };
      }
      const finalized = checked(
        await client.rpc("dispatch_finalize_task", {
          p_org: org,
          p_job: task.job_id,
          p_source_version: task.source_version,
          p_plan_version: task.plan_version,
          p_lease_token: task.lease_token,
          p_status: "done",
          p_result: result,
        }),
      );
      results.push({
        job_id: task.job_id,
        ...result,
        task_status: finalized.status,
      });
    } catch (e) {
      const result = { status: "failed", error: (e as Error).message };
      const finalized = await client.rpc("dispatch_finalize_task", {
        p_org: org,
        p_job: task.job_id,
        p_source_version: task.source_version,
        p_plan_version: task.plan_version,
        p_lease_token: task.lease_token,
        p_status: "failed",
        p_error: result.error,
        p_result: result,
      });
      results.push({
        job_id: task.job_id,
        ...result,
        task_status: finalized.error ? "lease_lost" : finalized.data.status,
      });
    }
  }
  return { results, live_actions_enabled: false };
}
export async function dispatchTasks(
  client: any,
  org: string,
  params: URLSearchParams,
) {
  const limit = Number(params.get("limit") ?? 25);
  const offset = Number(params.get("offset") ?? 0);
  const status = params.get("status");
  if (
    !Number.isInteger(limit) || limit < 1 || limit > 100 ||
    !Number.isSafeInteger(offset) || offset < 0 ||
    (status !== null &&
      ![
        "pending",
        "running",
        "done",
        "failed",
        "deferred",
        "exhausted",
        "resolved",
      ].includes(status))
  ) {
    throw new DispatchError("Invalid task status or pagination");
  }
  return checked(
    await client.rpc("dispatch_list_tasks", {
      p_org: org,
      p_status: status,
      p_limit: limit,
      p_offset: offset,
    }),
  );
}
export async function dispatchRetryTask(
  client: any,
  org: string,
  actor: string,
  body: any,
) {
  if (
    (body.source_version == null) !== (body.plan_version == null) ||
    (body.plan_version != null &&
      (!Number.isSafeInteger(body.plan_version) || body.plan_version < 0))
  ) {
    throw new DispatchError(
      "Source and plan version must identify the same task",
    );
  }
  return checked(
    await client.rpc("dispatch_retry_task", {
      p_org: org,
      p_job: uuid(body.job_id),
      p_request: uuid(body.request_id),
      p_source_version: body.source_version == null
        ? null
        : text(body.source_version, "source_version", 200),
      p_plan_version: body.plan_version ?? null,
      p_actor: actor,
      p_reason: text(body.reason, "reason", 2000),
    }),
  );
}
export function handleDispatch(
  client: any,
  org: string,
  actor: string,
  action: string,
  method: string,
  params: URLSearchParams,
  body: any,
) {
  if (
    [
      "dispatch_command",
      "dispatch_assess",
      "dispatch_trigger",
      "dispatch_run",
      "dispatch_retry_task",
    ]
      .includes(action)
  ) {
    if (method !== "POST") throw new DispatchError("POST required", 405);
    if (action === "dispatch_trigger") {
      return dispatchTrigger(client, org, body);
    }
    if (action === "dispatch_run") return dispatchRun(client, org, actor);
    if (action === "dispatch_retry_task") {
      return dispatchRetryTask(client, org, actor, body);
    }
    return dispatchCommand(
      client,
      org,
      actor,
      action === "dispatch_assess"
        ? { ...body, command: "assess", payload: {} }
        : body,
    );
  }
  if (method !== "GET") throw new DispatchError("GET required", 405);
  if (action === "dispatch_list") return dispatchList(client, org, params);
  if (action === "dispatch_tasks") return dispatchTasks(client, org, params);
  if (action === "dispatch_job") {
    return readDispatchJob(client, org, uuid(params.get("job_id")));
  }
  if (action === "dispatch_communications") {
    return dispatchCommunications(client, org, params);
  }
  if (action === "dispatch_supply") return dispatchSupply(client, org, params);
  if (action === "dispatch_calendar") {
    return dispatchCalendar(client, org, params);
  }
  if (action === "dispatch_workflow") {
    return dispatchWorkflow(client, org);
  }
  throw new DispatchError("Unknown Dispatch action", 404);
}

export async function dispatchWorkflow(client: any, org: string) {
  const intendedEnabled = false;
  const observedEnabled = Deno.env.get("DISPATCH_WORKER_ENABLED") === "true";
  const controls = checked(
    await client.from("dispatch_release_controls").select(
      "communications_enabled",
    ).eq("org_id", org).limit(1),
  ) || [];
  const tasks = await dispatchTasks(
    client,
    org,
    new URLSearchParams({ limit: "1", offset: "0" }),
  );
  return {
    workflow: "dispatch",
    definition_version: "dispatch-workflow/v1",
    live_actions_enabled: false,
    worker: {
      intended_enabled: intendedEnabled,
      observed_enabled: observedEnabled,
      schedule_installed: false,
      config_path: "scripts/dispatch/worker.disabled.json",
      manual_command: "bash scripts/dispatch/run-dispatch-worker.sh --once",
      mismatch: intendedEnabled !== observedEnabled,
    },
    communications_enabled: controls[0]?.communications_enabled === true,
    latest_task: (tasks.items || [])[0] || null,
    latest_source_failure: (tasks.source_failures || [])[0] || null,
    coverage: {
      tasks_complete: tasks.has_more !== true,
      source_failures_complete: tasks.source_failures_has_more !== true,
    },
  };
}

export async function dispatchSupply(
  client: any,
  org: string,
  params: URLSearchParams,
) {
  const kind = params.get("kind") ?? "po";
  if (!["po", "stock"].includes(kind)) {
    throw new DispatchError("Unsupported supply kind");
  }
  if (kind === "stock") {
    let q = client.from("dispatch_supply_lots").select("*").eq("org_id", org)
      .like("id", "stock:%").order("id").limit(51);
    if (params.get("cursor")) q = q.gt("id", params.get("cursor"));
    const data = checked(await q) || [];
    return {
      supply_lots: data.slice(0, 50),
      next_cursor: data.length > 50 ? data[49].id : null,
      coverage: {
        complete: data.length <= 50,
        source: "Audited Dispatch physical stock counts",
      },
    };
  }
  let q = client.from("purchase_orders").select("*").eq("org_id", org).in(
    "status",
    ["submitted", "authorised", "sent", "confirmed", "delivered", "billed"],
  ).order("id").limit(51);
  if (params.get("cursor")) q = q.gt("id", uuid(params.get("cursor")));
  const pos = checked(await q) || [], lots = [];
  for (const po of pos.slice(0, 50)) {
    for (
      const [index, line] of (Array.isArray(po.line_items) ? po.line_items : [])
        .entries()
    ) {
      lots.push({
        id: `po:${po.id}:${index}`,
        description: line.description,
        quantity: Number(line.quantity),
        unit: line.unit || null,
        source_ref: {
          kind: "purchase_order_line",
          po_id: po.id,
          job_id: po.job_id,
          index,
        },
        source_version: await hash(line),
      });
    }
  }
  return {
    supply_lots: lots,
    next_cursor: pos.length > 50 ? pos[49].id : null,
    coverage: {
      complete: pos.length <= 50,
      source:
        "Ordered PO lines across this organisation; quantities still require atomic reservation",
    },
  };
}
