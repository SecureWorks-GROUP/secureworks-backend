// deno-lint-ignore-file no-explicit-any
// Dispatch v2: where each supplier order is at (the material stage). The
// rules, pure. Contract: docs/dispatch-v2-board-contract.md, section 3b.
//
// Shaun and Marnin, 27 Oct 2026: a job has its own stage (Order Materials
// through Scheduled, then In Progress and Rectification), and the materials
// have theirs. Every material stage says who it is waiting on, so the board
// can show what is waiting on us and what is waiting on a supplier.
//
// In v2 one supplier box (job_material_suppliers) is one supplier's orders on
// one job. A person can set the box's stage by hand (migration
// 20261028170000_dispatch_v2_material_stages.sql, the press in
// dispatch_v2_material_stage_write.ts). Until they do, or when something newer
// happens on the box, the stage is worked out from the box itself:
//
//   * Whatever happened last decides. The newest of: the stage a person set,
//     the newest order email sent from the box ("Sent to supplier"), and the
//     newest change to a line still not sent ("Order materials": there is
//     something new to order, for example a flashing on a job already on
//     site).
//   * A delivery date confirmed after that (typed and ticked, or accepted
//     from a supplier reply) lifts an earlier stage to "Order confirmed". It
//     never moves a later stage back.
//   * An empty box with nothing sent is "Order materials".
//
// A purchase order with no box (a v1 Dispatch order or one made elsewhere) has
// no stage of its own: it is read from the order's status.
//
// Nothing here reads or writes the database.

export type DispatchMaterialWaitingOn = "us" | "supplier" | "nobody";

export const DISPATCH_MATERIAL_STAGES = [
  { key: "order_materials", label: "Order materials" },
  { key: "sent", label: "Sent to supplier" },
  { key: "quote_received", label: "Quote received" },
  { key: "awaiting_payment", label: "Awaiting payment" },
  { key: "order_confirmed", label: "Order confirmed" },
  { key: "manufacturing", label: "Manufacturing" },
  { key: "ready", label: "Materials ready" },
  { key: "delivered", label: "Delivered" },
] as const;

export type DispatchMaterialStageKey =
  typeof DISPATCH_MATERIAL_STAGES[number]["key"];

const STAGE_KEYS: readonly string[] = DISPATCH_MATERIAL_STAGES.map((s) =>
  s.key
);

export function isDispatchMaterialStage(
  value: unknown,
): value is DispatchMaterialStageKey {
  return typeof value === "string" && STAGE_KEYS.includes(value);
}

export function dispatchMaterialStageLabel(key: string): string {
  return DISPATCH_MATERIAL_STAGES.find((s) => s.key === key)?.label || key;
}

// Position in the list, 0-based; -1 for an unknown key.
export function dispatchMaterialStageRank(key: string): number {
  return STAGE_KEYS.indexOf(key);
}

// Who the stage is waiting on. Order confirmed is ours until the install is
// booked (tell the client, book the crew), then the supplier's.
export function dispatchMaterialWaitingOn(
  key: string,
  installBooked: boolean,
): DispatchMaterialWaitingOn {
  switch (key) {
    case "order_materials":
    case "quote_received":
    case "awaiting_payment":
    case "ready":
      return "us";
    case "order_confirmed":
      return installBooked ? "supplier" : "us";
    case "sent":
    case "manufacturing":
      return "supplier";
    default:
      return "nobody";
  }
}

// The one line the card and the box show: what needs doing next, in plain
// words. Null once delivered.
export function dispatchMaterialTodo(
  key: string,
  supplierName: string | null,
  installBooked: boolean,
): string | null {
  const s = supplierName || "the supplier";
  switch (key) {
    case "order_materials":
      return `Send the order to ${s}`;
    case "sent":
      return `Waiting on ${s} to reply`;
    case "quote_received":
      return `Check the quote from ${s}`;
    case "awaiting_payment":
      return `Pay ${s}`;
    case "order_confirmed":
      return installBooked
        ? `Waiting on ${s} for the materials`
        : "Book the install and tell the client";
    case "manufacturing":
      return `${s} is making it`;
    case "ready":
      return `Arrange delivery or pickup from ${s}`;
    default:
      return null;
  }
}

export type DispatchMaterialStageInput = {
  // The box's own stage and when a person set it (null = never set).
  stored: unknown;
  storedAt: unknown;
  // When each order email from this box was sent (status sent only).
  sentAts: unknown[];
  // When each line still to be ordered last changed: lines in the box with no
  // order email, no purchase order and not In stock.
  unsentLineChanges: unknown[];
  // When the box's delivery date was confirmed (null = not confirmed).
  confirmedAt: unknown;
};

export type DispatchMaterialStageShown = {
  key: DispatchMaterialStageKey;
  // set = a person chose it and nothing newer happened; worked_out = read
  // from the box.
  source: "set" | "worked_out";
};

function instant(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function newest(values: unknown[] | null | undefined): number | null {
  let best: number | null = null;
  for (const v of values || []) {
    const ms = instant(v);
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best;
}

/** The stage a supplier box shows, by the rules at the top of this file. */
export function dispatchMaterialStageOf(
  input: DispatchMaterialStageInput,
): DispatchMaterialStageShown {
  // Each candidate with the moment it happened. On the same moment a stage a
  // person set wins, then a send, then a line change.
  const candidates: {
    at: number;
    key: DispatchMaterialStageKey;
    source: "set" | "worked_out";
  }[] = [];
  const storedAt = instant(input.storedAt);
  if (isDispatchMaterialStage(input.stored) && storedAt !== null) {
    candidates.push({ at: storedAt, key: input.stored, source: "set" });
  }
  const sentAt = newest(input.sentAts);
  if (sentAt !== null) {
    candidates.push({ at: sentAt, key: "sent", source: "worked_out" });
  }
  const lineAt = newest(input.unsentLineChanges);
  if (lineAt !== null) {
    candidates.push({
      at: lineAt,
      key: "order_materials",
      source: "worked_out",
    });
  }
  let shown: {
    at: number;
    key: DispatchMaterialStageKey;
    source: "set" | "worked_out";
  } = {
    at: -Infinity,
    key: "order_materials",
    source: "worked_out",
  };
  for (const c of candidates) {
    if (c.at > shown.at) shown = c;
  }
  const confirmedAt = instant(input.confirmedAt);
  if (
    confirmedAt !== null && confirmedAt > shown.at &&
    dispatchMaterialStageRank(shown.key) <
      dispatchMaterialStageRank("order_confirmed")
  ) {
    return { key: "order_confirmed", source: "worked_out" };
  }
  return { key: shown.key, source: shown.source };
}

// A purchase order's stage, from its status (a v1 Dispatch order or one made
// elsewhere, with no supplier box).
export function dispatchPoMaterialStage(
  status: unknown,
): DispatchMaterialStageKey {
  switch (String(status ?? "").trim().toLowerCase()) {
    case "sent":
    case "submitted":
    case "authorised":
    case "acked":
      return "sent";
    case "confirmed":
      return "order_confirmed";
    case "delivered":
    case "billed":
      return "delivered";
    default:
      return "order_materials";
  }
}

// Lines in a box still to be ordered: no order email, no purchase order and
// not In stock (the same lines Make email builds from).
export function dispatchUnsentLineChanges(
  lines: any[] | null | undefined,
  supplierId: string,
): string[] {
  const out: string[] = [];
  for (const line of lines || []) {
    if (String(line?.supplier_id ?? "") !== supplierId) continue;
    if (line?.status === "in_stock") continue;
    if (line?.dispatch_order_email_id || line?.purchase_order_id) continue;
    const at = typeof line?.updated_at === "string" && line.updated_at
      ? line.updated_at
      : typeof line?.created_at === "string"
      ? line.created_at
      : null;
    // A line with no time at all still counts, as the oldest possible change.
    out.push(at || "1970-01-01T00:00:00.000Z");
  }
  return out;
}
