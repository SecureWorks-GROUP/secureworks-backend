// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2 (docs/dispatch-v2-emails-contract.md): the draft list, supplier
// boxes, photos and supplier order emails in dispatch_v2_store.ts, end to end,
// against an in-memory stand-in for PostgREST and storage. The stand-in knows
// every column the code may name (a wrong column name is a 42703, as live) and
// keeps the migrations' keys: the line-to-box link, one box per supplier per
// job, one main tick per job, one open email per box.
//
// NO EMAIL IS SENT. Every send goes to a fake sender that only records what it
// was asked to send. Job, client and supplier details are made up.
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISPATCH_V2_ACTIONS,
  DISPATCH_V2_READ_ACTIONS,
  DISPATCH_V2_WRITE_ACTIONS,
  type DispatchV2Context,
  type DispatchV2OutlookPayload,
  type DispatchV2SendOutcome,
  projectDispatchV2Email,
  runDispatchV2Action,
} from "./dispatch_v2_store.ts";
import { DispatchMaterialsError } from "./dispatch_materials_store.ts";
import { JobStartDepositError } from "./job_start_deposits.ts";
import { canonicalJsonAndHash } from "../_shared/release_packet/canonicalize.ts";

// index.ts reads SUPABASE_URL and the service key into module constants, so
// they are set before it is imported (a closed local port) and restored.
const SERVICE_KEY = "test-service-role-key";
const ROUTINE_KEY = "test-routine-key";
const IMPORT_ENV: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
};
const index = await (async () => {
  const saved = new Map(
    Object.keys(IMPORT_ENV).map((n) => [n, Deno.env.get(n)]),
  );
  for (const [name, value] of Object.entries(IMPORT_ENV)) {
    Deno.env.set(name, value);
  }
  try {
    return await import("./index.ts");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
})();
const {
  _authorizeOpsApiAction,
  _opsApiRequestHandlerForTest,
  AGENT_READ_ALLOWED_ACTIONS,
  LEAD_INSTALLER_READ_ACTIONS,
} = index;

const ORG = "00000000-0000-0000-0000-000000000001";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000ee";
type Row = Record<string, any>;

function uuid(prefix: string, n: number): string {
  return `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
const JOB = {
  fence: uuid("a1", 1),
  patio: uuid("a1", 2),
  repair: uuid("a1", 3),
  decking: uuid("a1", 4),
  makesafe: uuid("a1", 5),
  other: uuid("a1", 6),
  misc: uuid("a1", 7),
};
const SUP = {
  stratco: uuid("b1", 1),
  metroll: uuid("b1", 2),
  plain: uuid("b1", 3),
  inactive: uuid("b1", 4),
  oldlink: uuid("b1", 5),
  otherOrg: uuid("b1", 6),
};
const APPROVED = {
  stratco: uuid("c1", 1),
  metroll: uuid("c1", 2),
  unlinked: uuid("c1", 3),
  retired: uuid("c1", 4),
};
const L = (n: number) => uuid("e1", n);
const SHAUN = { userId: uuid("d1", 1), email: "shaun@ops.test", orgId: ORG };

const SCHEMA: Record<string, string[]> = {
  // Make email writes one audit line here when it changes a box's date
  // choice (piece C); nothing else in the store writes it.
  job_events: ["id", "job_id", "user_id", "event_type", "detail_json", "created_at"],
  jobs: [
    "id",
    "org_id",
    "job_number",
    "type",
    "status",
    "client_name",
    "client_phone",
    "site_address",
    "site_suburb",
    "metadata",
    "scope_json",
    "pricing_json",
    "expected_costs",
  ],
  // The acceptance chain Context's material-take rule reads (D1 fix F3).
  job_documents: ["id", "job_id", "type", "accepted_at"],
  run_acceptances: ["job_id", "status", "job_document_id"],
  job_variations: ["job_id", "accepted_at", "status"],
  quote_revisions: ["job_id", "job_document_id", "scope_revision_id", "sent_at"],
  // The job's frozen scope revisions (T20).
  scope_revisions: [
    "id",
    "job_id",
    "status",
    "revision_number",
    "scope_hash",
    "pricing_hash",
    "scope_canonical_text",
  ],
  suppliers: [
    "id",
    "org_id",
    "xero_contact_id",
    "name",
    "email",
    "phone",
    "is_active",
    "synced_at",
    "created_at",
    "updated_at",
  ],
  job_material_lines: [
    "id",
    "org_id",
    "job_id",
    "supplier_id",
    "description",
    "quantity",
    "unit",
    "status",
    "purchase_order_id",
    "source",
    "position",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "created_by_email",
    "updated_by_email",
    "detail",
    "profile",
    "colour",
    "dispatch_order_email_id",
    // The line's provenance (production migration 20261019200000).
    "source_kind",
    "source_version_id",
    "source_version",
    "source_line_id",
    // Ruling 17 step 3: migration 20261114020000_dispatch_line_budget_cost.sql.
    "budget_id",
    "budget_line_key",
    "cost_reason_id",
  ],
  job_material_suppliers: [
    "id",
    "org_id",
    "job_id",
    "supplier_id",
    "supplier_name",
    "position",
    "created_at",
    "created_by",
    "created_by_email",
    "is_main_supplier",
    // 20261023160000_dispatch_v2_board_arrival_dates.sql
    "delivery_date",
    "delivery_date_source",
    "delivery_date_set_at",
    "delivery_date_set_by_email",
    "delivery_date_confirmed_at",
    "delivery_date_confirmed_by",
    "delivery_date_confirmed_by_email",
    // 20261028170000_dispatch_v2_material_stages.sql
    "material_stage",
    "material_stage_set_at",
    "material_stage_set_by_email",
    // 20261029120100_dispatch_v2_box_paid.sql
    "paid_at",
    "paid_by",
    "paid_by_email",
    // 20261029120200_dispatch_v2_box_pay_on.sql
    "pay_on",
    "pay_on_set_at",
    "pay_on_set_by",
    "pay_on_set_by_email",
    // 20261029120300_dispatch_v2_box_payment_reopened.sql
    "payment_reopened_at",
    // 20261030120000_dispatch_v2_box_date_mode.sql
    "order_date_mode",
    "order_date_mode_set_at",
    "order_date_mode_set_by_email",
  ],
  dispatch_approved_supplier_emails: [
    "id",
    "org_id",
    "name",
    "used_for",
    "to_emails",
    "cc_emails",
    "active",
    "approved_by",
    "approved_on",
    "created_at",
    "updated_at",
    // 20261029120000_dispatch_v2_on_account_suppliers.sql
    "on_account",
    // 20261111160000_dispatch_v2_solarspan_as_bondor.sql (recognise-only)
    "also_known_emails",
  ],
  dispatch_approved_supplier_email_links: [
    "supplier_id",
    "approved_id",
    "org_id",
    "created_at",
    "created_by_email",
  ],
  // 20261105184500_dispatch_v2_supplier_picker.sql: the bill count view the
  // Add supplier search reads (one row per linked Xero contact).
  dispatch_approved_supplier_contact_bills: [
    "org_id",
    "approved_id",
    "supplier_id",
    "bills_12m",
    "last_bill_date",
    "is_pinned",
  ],
  // The install, for skips_ready (dispatch_board.ts loadDispatchInstall).
  job_assignments: [
    "id",
    "org_id",
    "job_id",
    "scheduled_date",
    "scheduled_end",
    "assignment_type",
    "status",
    "is_ghost",
    "role",
    "confirmation_status",
  ],
  // The reply step (dispatch_board.ts loadDispatchV2MatchedReplies).
  feature_flags: ["flag_name", "enabled"],
  dispatch_v2_supplier_emails: [
    "id",
    "org_id",
    "job_id",
    "state",
    "order_id",
    "received_at",
    "matched_at",
    "rung",
    "snippet",
    "delivery_date",
    "provider_message_id",
  ],
  // Which replies carry a PDF (dispatch_board.ts markDispatchV2ReplyPdfs).
  context_email_attachments: [
    "id",
    "provider_message_id",
    "file_name",
    "content_type",
    "status",
  ],
  dispatch_v2_scope_fills: [
    "job_id",
    "org_id",
    "auto",
    "lines_added",
    "supplier_id",
    "scope_supplier",
    "filled_at",
    "filled_by",
    "filled_by_email",
    // 20261102203000_dispatch_v2_scope_fill_revision.sql (T20)
    "scope_revision_id",
  ],
  dispatch_material_photos: [
    "id",
    "org_id",
    "job_id",
    "supplier_id",
    "file_name",
    "content_type",
    "size_bytes",
    "storage_path",
    "sha256",
    "created_at",
    "created_by",
    "created_by_email",
  ],
  dispatch_supplier_order_emails: [
    "id",
    "org_id",
    "job_id",
    "supplier_id",
    "supplier_name",
    "approved_email_id",
    "work_type",
    "is_main_supplier",
    "standing_lines_included",
    "status",
    "team_cc_email",
    "to_emails",
    "cc_emails",
    "subject",
    "body_text",
    "built_body_text",
    "delivery_date",
    "order_lines",
    "photo_ids",
    "test_sent_at",
    "test_sent_to",
    "test_sent_by_email",
    "test_internet_message_id",
    "test_conversation_id",
    "send_claimed_at",
    "sent_at",
    "sent_by",
    "sent_by_email",
    "sent_from_mailbox",
    "sent_to_emails",
    "sent_cc_emails",
    "sent_internet_message_id",
    "sent_conversation_id",
    "sent_graph_message_id",
    "last_error",
    "created_at",
    "created_by",
    "created_by_email",
    "updated_at",
    "updated_by_email",
    // Tweak 2: migration 20261105170000_dispatch_v2_outlook_orders.sql.
    "origin",
    "source_business_event_id",
    // Ruling 17 step 3: migration 20261114020000_dispatch_line_budget_cost.sql.
    "order_cost",
  ],
  job_budgets: ["id", "job_id", "scope_revision_id", "version", "trade", "budget"],
  dispatch_line_cost_reasons: [
    "id",
    "org_id",
    "job_id",
    "line_id",
    "budget_id",
    "budget_line_key",
    "basis",
    "reason",
    "quantity",
    "unit",
    "unit_cost_ex_gst",
    "given_by",
    "given_by_email",
    "given_at",
  ],
};

// The tables v2 may write. Anything else written is a failure.
const V2_WRITABLE = new Set([
  "job_material_lines",
  "job_material_suppliers",
  "dispatch_material_photos",
  "dispatch_supplier_order_emails",
  "dispatch_v2_scope_fills",
  "dispatch_line_cost_reasons",
  "storage",
  // Only the date choice audit line (checked in assertOnlyV2Writes).
  "job_events",
]);

function job(id: string, over: Row = {}): Row {
  return {
    id,
    org_id: ORG,
    job_number: "SWF-900001",
    type: "fencing",
    status: "order_materials",
    client_name: "Jeremy Example",
    client_phone: "0400 000 000",
    site_address: "1 Example St",
    site_suburb: "Exampleton",
    metadata: null,
    scope_json: null,
    pricing_json: null,
    ...over,
  };
}

function seed(): Record<string, Row[]> {
  const supplier = (id: string, name: string, over: Row = {}) => ({
    id,
    org_id: ORG,
    name,
    email: "xero-sync-owns-this@example.test",
    is_active: true,
    ...over,
  });
  const approved = (id: string, name: string, over: Row = {}) => ({
    id,
    org_id: ORG,
    name,
    used_for: "any",
    to_emails: [],
    cc_emails: [],
    active: true,
    on_account: false,
    approved_by: "Shaun",
    approved_on: "2026-10-23",
    ...over,
  });
  return {
    jobs: [
      job(JOB.fence, {
        scope_json: { items: ["Colorbond fence sheets", "Concrete bags (20kg)"] },
      }),
      job(JOB.patio, { type: "patio", job_number: "SWP-900002" }),
      job(JOB.repair, { type: "repair", job_number: "SWR-900003" }),
      job(JOB.decking, { type: "decking", job_number: "SWD-900004" }),
      job(JOB.makesafe, { type: "makesafe", job_number: "SWMS-90005" }),
      job(JOB.other, { org_id: OTHER_ORG }),
      job(JOB.misc, { type: "miscellaneous", job_number: "SWM-900007" }),
    ],
    suppliers: [
      supplier(SUP.stratco, "Stratco (WA) Pty Ltd"),
      supplier(SUP.metroll, "Metroll Perth"),
      supplier(SUP.plain, "Plain Hardware"),
      supplier(SUP.inactive, "Gone Supplies", { is_active: false }),
      supplier(SUP.oldlink, "Retired Link Supplies"),
      supplier(SUP.otherOrg, "Other Org Steel", { org_id: OTHER_ORG }),
    ],
    dispatch_approved_supplier_emails: [
      approved(APPROVED.stratco, "Stratco", {
        used_for: "fencing+patio",
        to_emails: ["tradewa@stratcowa.com.au"],
        cc_emails: ["tony.bacich@stratcowa.com.au"],
        // We have an account with Stratco (the payment step, section 3c).
        on_account: true,
      }),
      approved(APPROVED.metroll, "Metroll", {
        used_for: "patio",
        to_emails: ["orders@metroll.test"],
      }),
      approved(APPROVED.unlinked, "Unique Laser", {
        to_emails: ["orders@unique-laser.test"],
      }),
      approved(APPROVED.retired, "Retired", {
        to_emails: ["old@retired.test"],
        active: false,
      }),
    ],
    dispatch_approved_supplier_email_links: [
      { supplier_id: SUP.stratco, approved_id: APPROVED.stratco, org_id: ORG },
      { supplier_id: SUP.metroll, approved_id: APPROVED.metroll, org_id: ORG },
      { supplier_id: SUP.oldlink, approved_id: APPROVED.retired, org_id: ORG },
    ],
    dispatch_approved_supplier_contact_bills: [],
    job_material_suppliers: [],
    job_material_lines: [],
    dispatch_material_photos: [],
    dispatch_supplier_order_emails: [],
    dispatch_v2_scope_fills: [],
    scope_revisions: [],
    job_documents: [],
    run_acceptances: [],
    job_variations: [],
    quote_revisions: [],
    feature_flags: [],
    job_budgets: [],
    dispatch_line_cost_reasons: [],
    dispatch_v2_supplier_emails: [],
    context_email_attachments: [],
    job_assignments: [],
    job_events: [],
  };
}

// ── The stand-in ────────────────────────────────────────────────────────────

type Recorded = {
  table: string;
  kind: string;
  select: string;
  filters: Array<[string, string, unknown]>;
};

function makeDb(initial = seed()) {
  const tables: Record<string, Row[]> = structuredClone(initial);
  const requests: Recorded[] = [];
  const failures = new Set<string>();
  const files = new Map<string, Uint8Array>();

  const violation = (code: string, message: string) => ({
    data: null,
    error: { code, message },
  });

  function columnsOf(select: string): Array<[string, string]> {
    if (!select || select === "*") return [];
    return select.split(",").map((raw) => raw.trim()).filter(Boolean).map(
      (item) => {
        const colon = item.indexOf(":");
        return colon >= 0
          ? [item.slice(0, colon), item.slice(colon + 1)]
          : [item, item];
      },
    );
  }
  const baseColumn = (expression: string) => expression.split("->")[0];
  function valueOf(row: Row, expression: string): unknown {
    const text = /^(\w+)->>(\w+)$/.exec(expression);
    if (text) {
      const v = row[text[1]]?.[text[2]];
      return v === undefined || v === null ? null : String(v);
    }
    return row[expression];
  }
  function unknownColumn(table: string, names: string[]) {
    const known = SCHEMA[table];
    if (!known) return violation("42P01", `relation ${table} does not exist`);
    const bad = names.find((n) => !known.includes(baseColumn(n)));
    return bad
      ? violation("42703", `column ${table}.${bad} does not exist`)
      : null;
  }
  function project(row: Row, select: string): Row {
    if (!select || select === "*") return structuredClone(row);
    const out: Row = {};
    for (const [alias, expression] of columnsOf(select)) {
      out[alias] = structuredClone(valueOf(row, expression) ?? null);
    }
    return out;
  }

  // The migrations' keys and checks, as Postgres would enforce them.
  function checkRow(table: string, row: Row, all: Row[]) {
    const others = all.filter((r) => r !== row);
    if (table === "job_material_lines") {
      if (others.some((r) => r.id === row.id)) {
        return violation("23505", "job_material_lines_pkey");
      }
      if (
        row.supplier_id &&
        !tables.job_material_suppliers.some((b) =>
          b.job_id === row.job_id && b.supplier_id === row.supplier_id
        )
      ) return violation("23503", "job_material_lines_supplier_on_job_fkey");
      if (!["not_reviewed", "to_order", "in_stock"].includes(row.status)) {
        return violation("23514", "job_material_lines_status_valid");
      }
      // Production's provenance checks and index (20261019200000).
      const kind = row.source_kind ?? null;
      if (
        kind !== null &&
        !["quote_builder_version", "fence_scope_revision", "patio_scope_revision"]
          .includes(kind)
      ) return violation("23514", "job_material_lines_source_kind_valid");
      if (
        (kind === null) !== ((row.source_version_id ?? null) === null) ||
        (row.source === "scope" && kind === "quote_builder_version") ||
        ((row.source_line_id ?? null) !== null && (row.source_version_id ?? null) === null)
      ) return violation("23514", "job_material_lines_source_shape");
      if (
        row.source_line_id != null &&
        others.some((r) =>
          r.job_id === row.job_id && r.source_version_id === row.source_version_id &&
          r.source_line_id === row.source_line_id
        )
      ) return violation("23505", "job_material_lines_source_line_once");
    }
    if (table === "job_material_suppliers") {
      if (
        others.some((r) =>
          r.job_id === row.job_id && r.supplier_id === row.supplier_id
        )
      ) return violation("23505", "job_material_suppliers_job_supplier_key");
      if (
        row.is_main_supplier &&
        others.some((r) => r.job_id === row.job_id && r.is_main_supplier)
      ) return violation("23505", "job_material_suppliers_one_main_idx");
    }
    if (table === "dispatch_v2_scope_fills") {
      if (others.some((r) => r.job_id === row.job_id)) {
        return violation("23505", "dispatch_v2_scope_fills_pkey");
      }
    }
    if (table === "dispatch_material_photos") {
      if (
        row.supplier_id &&
        !tables.job_material_suppliers.some((b) =>
          b.job_id === row.job_id && b.supplier_id === row.supplier_id
        )
      ) {
        return violation(
          "23503",
          "dispatch_material_photos_supplier_on_job_fkey",
        );
      }
      if (!(row.size_bytes >= 1 && row.size_bytes <= 3_000_000)) {
        return violation("23514", "dispatch_material_photos_size");
      }
    }
    if (table === "dispatch_supplier_order_emails") {
      const open = ["draft", "sending", "send_unknown"];
      if (
        !["draft", "sending", "sent", "send_unknown", "discarded"].includes(
          row.status,
        )
      ) return violation("23514", "dispatch_supplier_order_emails_status_valid");
      if (
        open.includes(row.status) &&
        others.some((r) =>
          r.job_id === row.job_id && r.supplier_id === row.supplier_id &&
          open.includes(r.status)
        )
      ) return violation("23505", "dispatch_supplier_order_emails_one_open_idx");
      if (
        !Array.isArray(row.to_emails) || row.to_emails.length < 1 ||
        row.to_emails.length > 10
      ) return violation("23514", "dispatch_supplier_order_emails_to_count");
      if ((row.photo_ids || []).length > 3) {
        return violation("23514", "dispatch_supplier_order_emails_photo_count");
      }
      if (row.status === "sent" && !row.sent_at) {
        return violation(
          "23514",
          "dispatch_supplier_order_emails_sent_has_time",
        );
      }
    }
    return null;
  }

  function from(table: string) {
    const request: Recorded = { table, kind: "select", select: "", filters: [] };
    requests.push(request);
    const orders: Array<[string, boolean]> = [];
    let limit: number | null = null;
    let range: [number, number] | null = null;
    let single: "single" | "maybe" | null = null;
    let returning: string | null = null;
    let payload: any = null;
    let head = false;
    let counted = false;

    const matches = (row: Row) =>
      request.filters.every(([op, column, value]) => {
        const actual = valueOf(row, column);
        if (op === "eq") {
          return actual !== null && actual !== undefined &&
            String(actual) === String(value);
        }
        if (op === "neq") {
          return actual !== null && actual !== undefined &&
            String(actual) !== String(value);
        }
        if (op === "in") {
          return (value as unknown[]).map(String).includes(String(actual));
        }
        if (op === "is") return (actual ?? null) === value;
        if (op === "not.is") return (actual ?? null) !== value;
        if (op === "ilike") {
          const pattern = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/%/g, ".*");
          return new RegExp(`^${pattern}$`, "i").test(String(actual ?? ""));
        }
        throw new Error(`stand-in has no filter ${op}`);
      });

    const finish = (rows: Row[]) => {
      if (single === "single") {
        return rows.length === 1
          ? { data: rows[0], error: null }
          : violation("PGRST116", "not one row");
      }
      if (single === "maybe") {
        return rows.length > 1
          ? violation("PGRST116", "many rows")
          : { data: rows[0] ?? null, error: null };
      }
      if (request.kind !== "select" && returning === null) {
        return { data: null, error: null };
      }
      return { data: rows, error: null };
    };

    const execute = (): any => {
      if (failures.has(`${request.kind}:${table}`)) {
        return violation("XX000", `forced failure on ${request.kind} ${table}`);
      }
      const rows = tables[table] ||= [];
      const named = [
        ...columnsOf(
          request.kind === "select" ? request.select : (returning || ""),
        ).map(([, e]) => e),
        ...request.filters.map(([, c]) => c),
        ...orders.map(([c]) => c),
      ];
      const bad = unknownColumn(table, named);
      if (bad) return bad;
      if (request.kind === "select") {
        let found = rows.filter(matches);
        found.sort((a, b) => {
          for (const [c, asc] of orders) {
            if (a[c] === b[c]) continue;
            return (a[c] < b[c] ? -1 : 1) * (asc ? 1 : -1);
          }
          return 0;
        });
        if (head) return { data: null, count: found.length, error: null };
        const total = found.length;
        if (range) found = found.slice(range[0], range[1] + 1);
        if (limit !== null) found = found.slice(0, limit);
        const out = finish(found.map((r) => project(r, request.select)));
        return counted && !out.error ? { ...out, count: total } : out;
      }
      if (request.kind === "insert") {
        const incoming = (Array.isArray(payload) ? payload : [payload]).map((
          r: Row,
        ) => structuredClone(r));
        const badWrite = unknownColumn(
          table,
          incoming.flatMap((r: Row) => Object.keys(r)),
        );
        if (badWrite) return badWrite;
        for (const row of incoming) {
          if (table !== "dispatch_approved_supplier_email_links") {
            row.id ??= crypto.randomUUID();
          }
          row.created_at ??= new Date().toISOString();
          if (table === "job_material_suppliers") {
            row.is_main_supplier ??= false;
            // The column default (20261030120000): new boxes start on ASAP.
            row.order_date_mode ??= "asap";
          }
          if (table === "dispatch_supplier_order_emails") {
            row.cc_emails ??= [];
            row.photo_ids ??= [];
            row.order_lines ??= [];
          }
          const failure = checkRow(table, row, [...rows, ...incoming]);
          if (failure) return failure;
        }
        rows.push(...incoming);
        return finish(incoming.map((r: Row) => project(r, returning || "*")));
      }
      if (request.kind === "update") {
        const badWrite = unknownColumn(table, Object.keys(payload));
        if (badWrite) return badWrite;
        const targets = rows.filter(matches);
        const next = targets.map((t) => ({ ...t, ...structuredClone(payload) }));
        for (const n of next) {
          const failure = checkRow(
            table,
            n,
            rows.map((r) => next[targets.indexOf(r)] ?? r),
          );
          if (failure) return failure;
        }
        targets.forEach((t, i) => Object.assign(t, next[i]));
        return finish(targets.map((r) => project(r, returning || "*")));
      }
      const targets = rows.filter(matches);
      if (
        table === "job_material_suppliers" &&
        targets.some((box) =>
          tables.job_material_lines.some((l) =>
            l.job_id === box.job_id && l.supplier_id === box.supplier_id
          )
        )
      ) return violation("23503", "job_material_lines_supplier_on_job_fkey");
      tables[table] = rows.filter((r) => !targets.includes(r));
      return finish(targets.map((r) => project(r, returning || "id")));
    };

    const builder: any = {
      select(columns: string, options?: { head?: boolean; count?: string }) {
        if (request.kind === "select") request.select = columns;
        else returning = columns;
        if (options?.head) head = true;
        if (options?.count) counted = true;
        return builder;
      },
      insert(value: any) {
        request.kind = "insert";
        payload = value;
        return builder;
      },
      update(value: any) {
        request.kind = "update";
        payload = value;
        return builder;
      },
      delete() {
        request.kind = "delete";
        return builder;
      },
      eq(c: string, v: unknown) {
        request.filters.push(["eq", c, v]);
        return builder;
      },
      neq(c: string, v: unknown) {
        request.filters.push(["neq", c, v]);
        return builder;
      },
      in(c: string, v: unknown[]) {
        request.filters.push(["in", c, v]);
        return builder;
      },
      is(c: string, v: unknown) {
        request.filters.push(["is", c, v]);
        return builder;
      },
      not(c: string, op: string, v: unknown) {
        request.filters.push([`not.${op}`, c, v]);
        return builder;
      },
      ilike(c: string, v: string) {
        request.filters.push(["ilike", c, v]);
        return builder;
      },
      order(c: string, o?: { ascending?: boolean }) {
        orders.push([c, o?.ascending !== false]);
        return builder;
      },
      limit(n: number) {
        limit = n;
        return builder;
      },
      range(a: number, b: number) {
        range = [a, b];
        return Promise.resolve(execute());
      },
      single() {
        single = "single";
        return builder;
      },
      maybeSingle() {
        single = "maybe";
        return builder;
      },
      then(resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };
    return builder;
  }

  const client = {
    from,
    rpc(name: string) {
      requests.push({ table: `rpc:${name}`, kind: "rpc", select: "", filters: [] });
      return Promise.resolve(violation("42883", `function ${name} does not exist`));
    },
    storage: {
      from(bucket: string) {
        assertEquals(bucket, "dispatch-material-photos");
        const note = (kind: string, path: string) =>
          requests.push({ table: "storage", kind, select: path, filters: [] });
        return {
          upload(path: string, bytes: Uint8Array, options: any) {
            note("upload", path);
            if (failures.has("storage:upload")) {
              return Promise.resolve({ data: null, error: { message: "down" } });
            }
            if (files.has(path) && !options?.upsert) {
              return Promise.resolve({
                data: null,
                error: { statusCode: "409", message: "exists" },
              });
            }
            files.set(path, new Uint8Array(bytes));
            return Promise.resolve({ data: { path }, error: null });
          },
          remove(paths: string[]) {
            note("remove", paths.join(","));
            for (const p of paths) files.delete(p);
            return Promise.resolve({ data: [], error: null });
          },
          download(path: string) {
            const bytes = files.get(path);
            return Promise.resolve(
              bytes
                ? { data: new Blob([bytes as BlobPart]), error: null }
                : { data: null, error: { message: "not found" } },
            );
          },
          createSignedUrl(path: string, seconds: number) {
            note("sign", path);
            return Promise.resolve(
              files.has(path)
                ? {
                  data: {
                    signedUrl: `https://storage.test/${path}?expires=${seconds}`,
                  },
                  error: null,
                }
                : { data: null, error: { message: "Object not found" } },
            );
          },
        };
      },
    },
  };
  return {
    client,
    tables,
    requests,
    failures,
    files,
    writes: () =>
      requests.filter((r) => !["select", "sign"].includes(r.kind)),
  };
}

// ── The fake sender: records, never sends ───────────────────────────────────

function fakeSender(
  answer: (p: DispatchV2OutlookPayload, n: number) => DispatchV2SendOutcome =
    (_p, n) => ({
      kind: "sent",
      ids: {
        graph_message_id: `graph-${n}`,
        internet_message_id: `<order-${n}@secureworkswa.test>`,
        conversation_id: `conv-${n}`,
      },
    }),
) {
  const sent: DispatchV2OutlookPayload[] = [];
  const sender = (payload: DispatchV2OutlookPayload) => {
    sent.push(structuredClone(payload));
    return Promise.resolve(answer(payload, sent.length));
  };
  return { sent, sender };
}

let clockMs = Date.UTC(2026, 9, 23, 2, 0, 0);
function ctx(
  sender = fakeSender().sender,
  over: Partial<DispatchV2Context> = {},
): DispatchV2Context {
  return {
    orgId: ORG,
    actor: SHAUN,
    extractMaterialsFromScope: (scope: any) =>
      (scope?.items || []).map((description: string) => ({
        description,
        quantity: 4,
        unit: null,
      })),
    sender,
    // Every call moves the clock one second on, as real stamps would.
    now: () => new Date(clockMs += 1000).toISOString(),
    // Every fixture job has its deposits paid unless a test says otherwise.
    depositGate: () => Promise.resolve(),
    ...over,
  };
}

const params = (values: Record<string, string> = {}) =>
  new URLSearchParams(values);

function call(
  db: ReturnType<typeof makeDb>,
  action: string,
  body: Row,
  c = ctx(),
): Promise<any> {
  return runDispatchV2Action(db.client, action, params(), body, c);
}

function get(
  db: ReturnType<typeof makeDb>,
  action: string,
  values: Record<string, string>,
  c = ctx(),
): Promise<any> {
  return runDispatchV2Action(db.client, action, params(values), null, c);
}

async function refused(
  promise: Promise<unknown>,
  status: number,
  code: string,
) {
  const error = await assertRejects(
    () => promise,
    DispatchMaterialsError,
  ) as DispatchMaterialsError;
  assertEquals([error.status, error.body.code], [status, code], error.message);
  return error;
}

// Freeze a job's scope as freeze_scope does (T20): one frozen scope_revisions
// row whose hashes are the canonicalJsonAndHash of the job's scope_json and
// pricing_json, and whose text is the canonical scope. A job with no pricing
// gets a stand-in pricing blob first (freeze_scope refuses an empty one).
async function seal(
  db: ReturnType<typeof makeDb>,
  jobId: string,
  n = 1,
  over: Row = {},
): Promise<string> {
  const row = db.tables.jobs.find((j: any) => j.id === jobId)!;
  row.pricing_json ??= { fixture: "pricing" };
  const scope = await canonicalJsonAndHash(row.scope_json);
  const pricing = await canonicalJsonAndHash(row.pricing_json);
  const id = uuid("f1", db.tables.scope_revisions.length + 1);
  db.tables.scope_revisions.push({
    id,
    job_id: jobId,
    status: "frozen",
    revision_number: n,
    scope_hash: scope.hash,
    pricing_hash: pricing.hash,
    scope_canonical_text: scope.canonical,
    ...over,
  });
  return id;
}

async function addBox(
  db: ReturnType<typeof makeDb>,
  jobId: string,
  supplierId: string,
) {
  return await call(db, "dispatch_v2_add_supplier", {
    job_id: jobId,
    supplier_id: supplierId,
  });
}

async function addLine(
  db: ReturnType<typeof makeDb>,
  jobId: string,
  n: number,
  line: Row,
) {
  const out = await call(db, "dispatch_v2_save_line", {
    job_id: jobId,
    line: { id: L(n), quantity: 1, ...line },
  });
  return out.line;
}

// A fencing job with two boxes: Stratco holds the panels and plinths, Metroll
// holds the gate. One In stock line stays in Stratco's box.
async function fencingJob(db = makeDb()) {
  await addBox(db, JOB.fence, SUP.metroll);
  await addBox(db, JOB.fence, SUP.stratco);
  await addLine(db, JOB.fence, 1, {
    supplier_id: SUP.stratco,
    description: "1800H standard width panels with 2400H posts",
    quantity: 14,
    profile: "Neetascreen",
    colour: "Monument",
  });
  await addLine(db, JOB.fence, 2, {
    supplier_id: SUP.stratco,
    description: "150mm standard width plinths",
    quantity: 14,
    colour: "Monument",
  });
  await addLine(db, JOB.fence, 3, {
    supplier_id: SUP.metroll,
    description: "gate posts",
    quantity: 2,
    detail: "Gate: Pedestrian gate 1270mm",
  });
  await addLine(db, JOB.fence, 4, {
    supplier_id: SUP.stratco,
    description: "Tek screws we have",
    status: "in_stock",
  });
  return db;
}

async function makeEmail(
  db: ReturnType<typeof makeDb>,
  jobId: string,
  supplierId: string,
  extra: Row = {},
) {
  return await call(db, "dispatch_v2_make_email", {
    job_id: jobId,
    supplier_id: supplierId,
    delivery_date: "2026-11-04",
    ...extra,
  });
}

function assertOnlyV2Writes(db: ReturnType<typeof makeDb>) {
  for (const w of db.writes()) {
    assert(V2_WRITABLE.has(w.table), `wrote ${w.kind} ${w.table}`);
  }
  for (const e of db.tables.job_events) {
    assertEquals(e.event_type, "dispatch_v2_date_mode_set", "no other job_events row");
  }
  assertEquals(
    db.tables.suppliers.map((s) => s.email),
    seed().suppliers.map((s) => s.email),
    "suppliers.email is never written",
  );
}

// ── The read ────────────────────────────────────────────────────────────────

Deno.test("read: boxes, draft list, main supplier, team CC and the no-approved-email block", async () => {
  const db = await fencingJob();
  await addBox(db, JOB.fence, SUP.plain);
  await addLine(db, JOB.fence, 9, { description: "Draft list line" });
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(read.job_number, "SWF-900001");
  assertEquals(read.work_type, "fencing");
  assertEquals(read.team_cc.email, "fencing@secureworkswa.com.au");
  assertEquals(read.from, "admin@secureworkswa.com.au");
  assertEquals(read.test_send_done, false);
  // Metroll was added first, but Stratco holds the panels.
  assertEquals(read.main_supplier_id, SUP.stratco);
  assertEquals(read.main_supplier_ticked, false);
  assertEquals(read.can_suggest, false);
  assertEquals(read.draft_list.lines.map((l: any) => l.id), [L(9)]);
  assertEquals(read.draft_list.lines[0].supplier_id, null);
  assertEquals(
    read.suppliers.map((s: any) => [s.supplier_id, s.is_main, !!s.send_blocked]),
    [
      [SUP.metroll, false, false],
      [SUP.stratco, true, false],
      [SUP.plain, false, true],
    ],
  );
  const stratco = read.suppliers[1];
  assertEquals(stratco.approved_email.to, ["tradewa@stratcowa.com.au"]);
  assertEquals(stratco.lines.map((l: any) => l.id), [L(1), L(2), L(4)]);
  assertEquals(stratco.lines[0].profile, "Neetascreen");
  assertEquals(read.suppliers[2].send_blocked.code, "no_approved_email");
  // The payment step's terms (contract section 3c): Stratco is on account,
  // Metroll pays first, and a supplier with no approved entry pays first too.
  assertEquals(stratco.approved_email.on_account, true);
  assertEquals(read.suppliers[0].approved_email.on_account, false);
  assertEquals(
    read.suppliers.map((s: any) => s.payment.terms),
    ["pay_first", "on_account", "pay_first"],
  );
  assertOnlyV2Writes(db);
});

Deno.test("read: the payment gate holds a pay-first box's confirmed date, as on the board", async () => {
  const db = await fencingJob();
  for (const box of db.tables.job_material_suppliers) {
    Object.assign(box, {
      delivery_date: "2026-11-05",
      delivery_date_set_at: "2027-01-01T00:00:00.000Z",
      delivery_date_confirmed_at: "2027-01-01T00:00:00.000Z",
    });
  }
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  const [metroll, stratco] = read.suppliers;
  // Metroll pays first: the date lifts it only to Awaiting payment.
  assertEquals(metroll.material_stage.key, "awaiting_payment");
  assertEquals(metroll.material_stage.held_by_payment, true);
  assertEquals(metroll.payment.holds_stage, true);
  // Stratco is on account: Order confirmed as before.
  assertEquals(stratco.material_stage.key, "order_confirmed");
  assertEquals(stratco.material_stage.held_by_payment, false);
  assertOnlyV2Writes(db);
});

Deno.test("read: a matched supplier reply moves the box on, as on the board", async () => {
  const db = await fencingJob();
  const sentAt = "2026-10-28T01:00:00.000Z";
  const emailId = "00000000-0000-0000-0000-0000000e0001";
  const columns = SCHEMA.dispatch_supplier_order_emails;
  const email: Row = Object.fromEntries(columns.map((c) => [c, null]));
  Object.assign(email, {
    id: emailId,
    org_id: ORG,
    job_id: JOB.fence,
    supplier_id: SUP.metroll,
    status: "sent",
    body_text: "Hi, please deliver the following.",
    sent_at: sentAt,
    created_at: sentAt,
    updated_at: sentAt,
    to_emails: [],
    cc_emails: [],
    order_lines: [],
    photo_ids: [],
    sent_to_emails: [],
    sent_cc_emails: [],
  });
  db.tables.dispatch_supplier_order_emails.push(email);
  db.tables.dispatch_v2_supplier_emails.push({
    id: "00000000-0000-0000-0000-0000000b0001",
    org_id: ORG,
    job_id: JOB.fence,
    state: "matched",
    order_id: emailId,
    received_at: "2026-10-28T04:00:00.000Z",
    matched_at: "2026-10-28T04:01:00.000Z",
    rung: "thread",
  });
  // Switch off: no reply is read, Metroll stays at Sent.
  const off = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(off.replies_read, "ok");
  assertEquals(off.suppliers[0].material_stage.key, "sent");
  // Switch on: Metroll pays first, so the reply moves it to Awaiting payment.
  db.tables.feature_flags.push({ flag_name: "dispatch_v2_replies_v1", enabled: true });
  const on = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  const metroll = on.suppliers[0];
  assertEquals(metroll.material_stage.key, "awaiting_payment");
  assertEquals(metroll.material_stage.source, "reply");
  assertEquals(metroll.material_stage.reply.email_id, "00000000-0000-0000-0000-0000000b0001");
  assertOnlyV2Writes(db);
});

Deno.test("read: a plain reply with no PDF, date or price leaves the box at Sent, with a note", async () => {
  // Shaun 6 Nov 2026: CMI's "All good Shaun" is not a quote.
  const db = await fencingJob();
  const sentAt = "2026-10-28T01:00:00.000Z";
  const emailId = "00000000-0000-0000-0000-0000000e0002";
  const columns = SCHEMA.dispatch_supplier_order_emails;
  const email: Row = Object.fromEntries(columns.map((c) => [c, null]));
  Object.assign(email, {
    id: emailId,
    org_id: ORG,
    job_id: JOB.fence,
    supplier_id: SUP.metroll,
    status: "sent",
    body_text: "Hi, please deliver the following.",
    sent_at: sentAt,
    created_at: sentAt,
    updated_at: sentAt,
    to_emails: [],
    cc_emails: [],
    order_lines: [],
    photo_ids: [],
    sent_to_emails: [],
    sent_cc_emails: [],
  });
  db.tables.dispatch_supplier_order_emails.push(email);
  db.tables.dispatch_v2_supplier_emails.push({
    id: "00000000-0000-0000-0000-0000000b0002",
    org_id: ORG,
    job_id: JOB.fence,
    state: "matched",
    order_id: emailId,
    received_at: "2026-10-28T04:00:00.000Z",
    matched_at: "2026-10-28T04:01:00.000Z",
    rung: "thread",
    snippet: "All good Shaun. Seems like you're getting busier.",
    delivery_date: null,
    provider_message_id: "msg-chat",
  });
  // The email's only file is a logo, not a PDF.
  db.tables.context_email_attachments.push({
    id: "att-logo",
    provider_message_id: "msg-chat",
    file_name: "image001.png",
    content_type: "image/png",
    status: "stored",
  });
  db.tables.feature_flags.push({ flag_name: "dispatch_v2_replies_v1", enabled: true });
  const on = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  const stage = on.suppliers[0].material_stage;
  assertEquals([stage.key, stage.source, stage.reply], ["sent", "worked_out", null]);
  assertEquals(stage.reply_note, {
    email_id: "00000000-0000-0000-0000-0000000b0002",
    received_at: "2026-10-28T04:00:00.000Z",
    snippet: "All good Shaun. Seems like you're getting busier.",
  });
  assertOnlyV2Writes(db);
});

Deno.test("read: a pickup on the install's first day skips Materials ready, as on the board", async () => {
  const db = await fencingJob();
  const sentAt = "2026-10-28T01:00:00.000Z";
  const columns = SCHEMA.dispatch_supplier_order_emails;
  const email: Row = Object.fromEntries(columns.map((c) => [c, null]));
  Object.assign(email, {
    id: "00000000-0000-0000-0000-0000000e0002",
    org_id: ORG,
    job_id: JOB.fence,
    supplier_id: SUP.metroll,
    status: "sent",
    body_text: "Hi, please have the following ready for pickup.",
    delivery_date: "2026-11-05",
    sent_at: sentAt,
    created_at: sentAt,
    updated_at: sentAt,
    to_emails: [],
    cc_emails: [],
    order_lines: [],
    photo_ids: [],
    sent_to_emails: [],
    sent_cc_emails: [],
  });
  db.tables.dispatch_supplier_order_emails.push(email);
  // No install booked: no skip.
  const before = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(before.suppliers[0].material_stage.skips_ready, false);
  db.tables.job_assignments.push({
    id: "00000000-0000-0000-0000-0000000a0001",
    org_id: ORG,
    job_id: JOB.fence,
    scheduled_date: "2026-11-05",
    scheduled_end: null,
    assignment_type: "install",
    status: "scheduled",
    is_ghost: false,
    role: "lead",
    confirmation_status: "confirmed",
  });
  const after = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(after.suppliers[0].fulfilment, "pickup");
  assertEquals(after.suppliers[0].material_stage.skips_ready, true);
  assertEquals(after.suppliers[1].material_stage.skips_ready, false);
  assertOnlyV2Writes(db);
});

Deno.test("read: a make-safe job, another org's job and a bad id are refused", async () => {
  const db = makeDb();
  await refused(
    get(db, "dispatch_v2_materials", { job_id: JOB.makesafe }),
    409,
    "not_dispatch_work",
  );
  await refused(
    get(db, "dispatch_v2_materials", { job_id: JOB.other }),
    404,
    "job_not_found",
  );
  await refused(
    get(db, "dispatch_v2_materials", { job_id: "nope" }),
    400,
    "invalid_request",
  );
  const repair = await get(db, "dispatch_v2_materials", { job_id: JOB.repair });
  assertEquals(repair.work_type, "repair");
  assertEquals(repair.team_cc.email, "ses@secureworkswa.com.au");
  const decking = await get(db, "dispatch_v2_materials", { job_id: JOB.decking });
  assertEquals(decking.team_cc.email, "patios@secureworkswa.com.au");
  assert(decking.team_cc.open_question);
});

// ── Supplier search ─────────────────────────────────────────────────────────

Deno.test("search: approved list first, then every other active supplier, each flagged", async () => {
  const db = makeDb();
  const all = await get(db, "dispatch_v2_supplier_search", {});
  assertEquals(
    all.approved.map((a: any) => [a.approved_name, a.supplier_id, a.can_add]),
    [
      ["Metroll", SUP.metroll, true],
      ["Stratco", SUP.stratco, true],
      ["Unique Laser", null, false],
    ],
  );
  assert(all.approved.every((a: any) => a.has_approved_email === true));
  // The retired entry's supplier and plain suppliers come after, unflagged;
  // inactive and other-org suppliers are not offered.
  assertEquals(
    all.others.map((o: any) => [o.name, o.has_approved_email]),
    [["Plain Hardware", false], ["Retired Link Supplies", false]].sort(),
  );
  const q = await get(db, "dispatch_v2_supplier_search", { q: "strat" });
  assertEquals(q.approved.map((a: any) => a.supplier_id), [SUP.stratco]);
  assertEquals(q.others, []);
});

// Tweak 4 (5 Nov 2026): one row per approved supplier, under its approved
// name, on its main Xero contact; the other contacts go under Show more.
const BD = {
  approved: uuid("c7", 1),
  rrApproved: uuid("c7", 2),
  main: uuid("c8", 1),
  second: uuid("c8", 2),
  third: uuid("c8", 3),
  rr: uuid("c8", 4),
};

function bdSeed(): Record<string, Row[]> {
  const init = seed();
  const contact = (id: string, name: string, xero: string | null) => ({
    id,
    org_id: ORG,
    name,
    email: "xero-sync-owns-this@example.test",
    is_active: true,
    xero_contact_id: xero,
  });
  init.suppliers.push(
    contact(BD.main, "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty", "xc-bd-1"),
    contact(BD.second, "B & D Metals", "xc-bd-2"),
    contact(BD.third, "B&D Metals Group", "xc-bd-3"),
    contact(BD.rr, "R&R FENCING", "xc-rr"),
  );
  const entry = (id: string, name: string, to: string) => ({
    id,
    org_id: ORG,
    name,
    used_for: "fencing",
    to_emails: [to],
    cc_emails: [],
    active: true,
    on_account: false,
    approved_by: "Shaun",
    approved_on: "2026-10-23",
  });
  init.dispatch_approved_supplier_emails.push(
    entry(BD.approved, "BD Metals", "orders@bd.test"),
    entry(BD.rrApproved, "RnR Fencing", "orders@rr.test"),
  );
  for (const id of [BD.main, BD.second, BD.third]) {
    init.dispatch_approved_supplier_email_links.push({
      supplier_id: id,
      approved_id: BD.approved,
      org_id: ORG,
    });
  }
  init.dispatch_approved_supplier_email_links.push({
    supplier_id: BD.rr,
    approved_id: BD.rrApproved,
    org_id: ORG,
  });
  const bills = (
    supplierId: string,
    approvedId: string,
    n: number,
    last: string | null,
  ) => ({
    org_id: ORG,
    approved_id: approvedId,
    supplier_id: supplierId,
    bills_12m: n,
    last_bill_date: last,
    is_pinned: false,
  });
  init.dispatch_approved_supplier_contact_bills.push(
    bills(BD.main, BD.approved, 36, "2026-10-30"),
    bills(BD.second, BD.approved, 2, "2026-11-01"),
    bills(BD.third, BD.approved, 0, null),
    bills(BD.rr, BD.rrApproved, 217, "2026-11-04"),
  );
  return init;
}

Deno.test("search (Tweak 4): b&d, bd and b and d all give one BD Metals row on its busiest Xero contact", async () => {
  const db = makeDb(bdSeed());
  for (const q of ["b&d", "bd", "b and d", "BD Metals", "jaiama"]) {
    const out = await get(db, "dispatch_v2_supplier_search", { q });
    assertEquals(out.ranking, "bills", q);
    assertEquals(
      out.approved.map((a: any) => [a.name, a.supplier_id, a.main_reason, a.other_contacts, a.can_add]),
      [["BD Metals", BD.main, "most_bills", 2, true]],
      q,
    );
    assertEquals(out.approved[0].xero_name, "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty");
    assertEquals(out.approved[0].bills_12m, 36);
    assertEquals(out.approved[0].to, ["orders@bd.test"]);
    // Show more: the other two contacts, busiest first, each on the same
    // approved email.
    assertEquals(
      out.more_approved.map((m: any) => [m.name, m.supplier_id, m.approved_name, m.can_add]),
      [
        ["B & D Metals", BD.second, "BD Metals", true],
        ["B&D Metals Group", BD.third, "BD Metals", true],
      ],
      q,
    );
    assertEquals(out.others, [], q);
  }
});

Deno.test("search (Tweak 4): rnr, r&r and r and r all find RnR Fencing", async () => {
  const db = makeDb(bdSeed());
  for (const q of ["rnr", "r&r", "r and r", "RnR", "R & R fencing"]) {
    const out = await get(db, "dispatch_v2_supplier_search", { q });
    assertEquals(
      out.approved.map((a: any) => [a.name, a.supplier_id, a.xero_name, a.main_reason]),
      [["RnR Fencing", BD.rr, "R&R FENCING", "only_contact"]],
      q,
    );
    assertEquals(out.more_approved, [], q);
  }
});

Deno.test("search (Tweak 4): a pin wins over the bill count; a tie goes to the newest bill", async () => {
  const init = bdSeed();
  init.dispatch_approved_supplier_contact_bills.find((r) => r.supplier_id === BD.third)!.is_pinned = true;
  let out = await get(makeDb(init), "dispatch_v2_supplier_search", { q: "bd" });
  assertEquals(out.approved[0].supplier_id, BD.third);
  assertEquals(out.approved[0].main_reason, "pinned");
  assertEquals(out.more_approved.map((m: any) => m.supplier_id), [BD.main, BD.second]);

  const tie = bdSeed();
  tie.dispatch_approved_supplier_contact_bills.find((r) => r.supplier_id === BD.second)!.bills_12m = 36;
  out = await get(makeDb(tie), "dispatch_v2_supplier_search", { q: "bd" });
  // Both have 36 bills; the second contact's newest bill (1 Nov) is newer.
  assertEquals(out.approved[0].supplier_id, BD.second);
});

Deno.test("search (Tweak 4): an approved supplier with no Xero contact shows greyed with Add to Xero first", async () => {
  const db = makeDb(bdSeed());
  const out = await get(db, "dispatch_v2_supplier_search", { q: "unique" });
  assertEquals(out.approved.length, 1);
  const row = out.approved[0];
  assertEquals([row.name, row.supplier_id, row.can_add], ["Unique Laser", null, false]);
  assertEquals(row.note, "Add to Xero first: this supplier has no Xero contact yet");
});

Deno.test("search (Tweak 4): the bill counts failing to read never stops the search", async () => {
  const db = makeDb(bdSeed());
  const saved = SCHEMA.dispatch_approved_supplier_contact_bills;
  delete SCHEMA.dispatch_approved_supplier_contact_bills;
  try {
    const out = await get(db, "dispatch_v2_supplier_search", { q: "b&d" });
    assertEquals(out.ranking, "unavailable");
    assertEquals(out.approved.map((a: any) => a.name), ["BD Metals"]);
    assert(out.approved[0].supplier_id);
    assertEquals(out.approved[0].bills_12m, null);
    assertEquals(out.more_approved.length, 2);
  } finally {
    SCHEMA.dispatch_approved_supplier_contact_bills = saved;
  }
});

Deno.test("boxes (Tweak 4): a box on a linked contact shows the approved name, with the Xero name beside it", async () => {
  const db = makeDb(bdSeed());
  const added = await addBox(db, JOB.fence, BD.main);
  assertEquals(added.supplier.name, "BD Metals");
  assertEquals(added.supplier.xero_name, "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty");
  await addBox(db, JOB.fence, SUP.plain);
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  const byId = new Map(read.suppliers.map((s: any) => [s.supplier_id, s]));
  assertEquals((byId.get(BD.main) as any).name, "BD Metals");
  assertEquals((byId.get(BD.main) as any).xero_name, "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty");
  // Not on the approved list: the Xero name, as before.
  assertEquals((byId.get(SUP.plain) as any).name, "Plain Hardware");
  // The box row itself still keeps the Xero contact's name.
  const box = db.tables.job_material_suppliers.find((b: any) => b.supplier_id === BD.main);
  assertEquals(box!.supplier_name, "Jaiama Investments Pty Ltd T/A B&D Metals Group Pty");
});

Deno.test("auto fill (Tweak 4): a scope naming B&D fills a box on BD Metals' main Xero contact", async () => {
  const db = makeDb(bdSeed());
  db.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("B&D");
  await seal(db, JOB.fence);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
  assertEquals(out.supplier.supplier_id, BD.main);
  // With the bill counts unreadable, the name order picks as before.
  const db2 = makeDb(bdSeed());
  db2.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("B&D");
  await seal(db2, JOB.fence);
  const saved = SCHEMA.dispatch_approved_supplier_contact_bills;
  delete SCHEMA.dispatch_approved_supplier_contact_bills;
  try {
    const fallback = await call(db2, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
    assertEquals(fallback.supplier.supplier_id, BD.second);
  } finally {
    SCHEMA.dispatch_approved_supplier_contact_bills = saved;
  }
});

// ── Lines ───────────────────────────────────────────────────────────────────

Deno.test("lines: into a box, between boxes and back to the draft list; stale stamp refused", async () => {
  const db = makeDb();
  await addBox(db, JOB.fence, SUP.stratco);
  await addBox(db, JOB.fence, SUP.metroll);
  let line = await addLine(db, JOB.fence, 1, { description: "Plinths" });
  assertEquals(line.supplier_id, null);
  line = (await call(db, "dispatch_v2_move_line", {
    job_id: JOB.fence,
    id: L(1),
    supplier_id: SUP.stratco,
    expected_updated_at: line.updated_at,
  })).line;
  assertEquals(line.supplier_id, SUP.stratco);
  const stale = line.updated_at;
  line = (await call(db, "dispatch_v2_move_line", {
    job_id: JOB.fence,
    id: L(1),
    supplier_id: SUP.metroll,
    expected_updated_at: line.updated_at,
  })).line;
  assertEquals(line.supplier_id, SUP.metroll);
  await refused(
    call(db, "dispatch_v2_move_line", {
      job_id: JOB.fence,
      id: L(1),
      supplier_id: null,
      expected_updated_at: stale,
    }),
    409,
    "line_changed",
  );
  line = (await call(db, "dispatch_v2_move_line", {
    job_id: JOB.fence,
    id: L(1),
    supplier_id: null,
    expected_updated_at: line.updated_at,
  })).line;
  assertEquals(line.supplier_id, null);
  // A box that is not on the job is refused.
  await refused(
    call(db, "dispatch_v2_move_line", {
      job_id: JOB.fence,
      id: L(1),
      supplier_id: SUP.plain,
      expected_updated_at: line.updated_at,
    }),
    409,
    "supplier_not_on_job",
  );
  // An edit keeps the box and adds the template's extra lines.
  const edited = (await call(db, "dispatch_v2_save_line", {
    job_id: JOB.fence,
    expected_updated_at: line.updated_at,
    line: {
      id: L(1),
      description: "Plinths",
      quantity: 3,
      detail: "Gate: Pedestrian gate 1270mm\n  ",
      colour: "Dune",
    },
  })).line;
  assertEquals([edited.quantity, edited.detail, edited.colour], [
    3,
    "Gate: Pedestrian gate 1270mm",
    "Dune",
  ]);
  // A retried insert is one row, never two.
  const again = await call(db, "dispatch_v2_save_line", {
    job_id: JOB.fence,
    line: { id: L(1), description: "Plinths" },
  });
  assertEquals(again.unchanged, true);
  assertEquals(db.tables.job_material_lines.length, 1);
  await call(db, "dispatch_v2_delete_line", {
    job_id: JOB.fence,
    id: L(1),
    expected_updated_at: edited.updated_at,
  });
  assertEquals(db.tables.job_material_lines.length, 0);
  assertOnlyV2Writes(db);
});

Deno.test("suggest: fills the draft list from the scope, leaves concrete bags out, and only once", async () => {
  const db = makeDb();
  await seal(db, JOB.fence);
  const first = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals(first.added, 1);
  assertEquals(first.lines[0].supplier_id, null);
  assertEquals(first.lines[0].source, "scope");
  assert(!first.lines.some((l: any) => /concrete/i.test(l.description)));
  await refused(
    call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence }),
    409,
    "lines_exist",
  );
  await refused(
    call(db, "dispatch_v2_suggest_draft", { job_id: JOB.repair }),
    409,
    "no_suggestion_for_work_type",
  );
});

Deno.test("suggest: a fence tool scope fills panels and plinths with profile and colour, and passes notes back", async () => {
  const db = makeDb();
  const fence = db.tables.jobs.find((j: any) => j.id === JOB.fence)!;
  fence.scope_json = {
    tool: "fence",
    job: {
      profile: "Neetascreen",
      colour: "Paperbark",
      gates: [],
      runs: [{
        name: "Rear",
        sheetHeight: 1800,
        panels: [
          { height: 1800, retaining: 150, panelWidth: "standard" },
          { height: 1800, retaining: 150, panelWidth: "long" },
        ],
      }],
    },
  };
  await seal(db, JOB.fence);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals(out.added, 2);
  assertEquals(
    out.lines.map((l: any) => [l.quantity, l.description, l.profile ?? null, l.colour ?? null, l.source]),
    [
      [2, "1800H standard width panels with 2700H posts", "Neetascreen", "Paperbark", "scope"],
      [2, "150mm standard width plinths", null, "Paperbark", "scope"],
    ],
  );
  assertEquals(out.notes, [
    "1 panel is marked long width in the scope. Check the panel line with the supplier.",
  ]);
  assertOnlyV2Writes(db);
});

// The fence tool scope the auto fill tests use: two panels, one supplier.
function fenceScope(supplier: string) {
  return {
    tool: "fence",
    job: {
      profile: "Neetascreen",
      colour: "Paperbark",
      supplier,
      gates: [],
      runs: [{ name: "Rear", panels: [{ height: 1800, retaining: 0 }, { height: 1800, retaining: 0 }] }],
    },
  };
}

Deno.test("auto fill: a fence scope naming its supplier fills that supplier's box, and never fills again", async () => {
  const db = makeDb();
  db.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("stratco ");
  const revision = await seal(db, JOB.fence);
  const before = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(before.auto_fill, true);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
  assertEquals(out.added, 1);
  assertEquals(out.supplier, { supplier_id: SUP.stratco, name: "Stratco (WA) Pty Ltd" });
  assertEquals(out.lines.map((l: any) => [l.quantity, l.description, l.supplier_id]), [
    [2, "1800H standard width panels with 2400H posts", SUP.stratco],
  ]);
  assertEquals(db.tables.job_material_suppliers.map((b: any) => b.supplier_id), [SUP.stratco]);
  assertEquals(db.tables.dispatch_v2_scope_fills.map((f: any) => [f.job_id, f.auto, f.lines_added, f.supplier_id, f.scope_supplier, f.scope_revision_id]), [
    [JOB.fence, true, 1, SUP.stratco, "stratco", revision],
  ]);
  const after = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(after.auto_fill, false);
  assertEquals(after.draft_list.lines, []);
  assertEquals(after.suppliers.map((b: any) => b.supplier_id), [SUP.stratco]);
  // A list cleared by hand is not filled again on its own; the button still works.
  db.tables.job_material_lines = [];
  assertEquals((await get(db, "dispatch_v2_materials", { job_id: JOB.fence })).auto_fill, false);
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true }), 409, "already_filled");
  const byHand = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals(byHand.added, 1);
  assertEquals(db.tables.job_material_suppliers.length, 1);
  assertEquals(db.tables.dispatch_v2_scope_fills.length, 1);
  assertOnlyV2Writes(db);
});

Deno.test("auto fill: a supplier with no approved order email leaves the lines on the draft list, with a note", async () => {
  const db = makeDb();
  db.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("Paralink");
  await seal(db, JOB.fence);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
  assertEquals(out.supplier, null);
  assertEquals(out.lines.map((l: any) => l.supplier_id), [null]);
  assertEquals(out.notes, [
    "The scope names Paralink as the supplier, which has no approved order email. The lines are on the draft list: add a supplier and move them in.",
  ]);
  assertEquals(db.tables.job_material_suppliers, []);
  // An approved email no active supplier contact is linked to says so too.
  const db2 = makeDb();
  db2.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("Unique Laser");
  await seal(db2, JOB.fence);
  const out2 = await call(db2, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
  assertEquals(out2.supplier, null);
  assertEquals(out2.notes, [
    "The scope names Unique Laser as the supplier, but no supplier contact is linked to its approved order email. The lines are on the draft list: add a supplier and move them in.",
  ]);
  // A scope with no supplier: the draft list, and no note about it.
  const db3 = makeDb();
  db3.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("");
  await seal(db3, JOB.fence);
  const out3 = await call(db3, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
  assertEquals([out3.supplier, out3.notes], [null, []]);
});

Deno.test("auto fill: fencing only, never over lines, and a box already there is reused", async () => {
  const db = makeDb();
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio, auto: true }), 409, "no_auto_fill");
  assertEquals((await get(db, "dispatch_v2_materials", { job_id: JOB.patio })).auto_fill, false);
  db.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("Stratco");
  await seal(db, JOB.fence);
  await addBox(db, JOB.fence, SUP.stratco);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
  assertEquals(out.supplier.supplier_id, SUP.stratco);
  assertEquals(db.tables.job_material_suppliers.length, 1);
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true }), 409, "already_filled");
  // A fence scope with nothing to order fills nothing and records nothing.
  const db2 = makeDb();
  db2.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = { tool: "fence", job: { supplier: "Stratco", runs: [], gates: [] } };
  await seal(db2, JOB.fence);
  const empty = await call(db2, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
  assertEquals([empty.added, db2.tables.dispatch_v2_scope_fills.length, db2.tables.job_material_suppliers.length], [0, 0, 0]);
});

// Tweak 2 (contract section 3f.1): an order Shaun sent from Outlook.
const OUTLOOK_BODY = [
  "Hi Team, could we please order the following for delivery:",
  "",
  "Materials Needed:",
  "1. 14 x panels",
].join("\n");
Deno.test("outlook order: shown as from Outlook; the screen's own fill never runs, the Fill press still does", async () => {
  const db = makeDb();
  db.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("Stratco");
  await seal(db, JOB.fence);
  // Before: an empty fencing list with a frozen scope fills on its own.
  assertEquals((await get(db, "dispatch_v2_materials", { job_id: JOB.fence })).auto_fill, true);
  const sentAt = "2026-11-03T09:05:03.000Z";
  const columns = SCHEMA.dispatch_supplier_order_emails;
  const email: Row = Object.fromEntries(columns.map((c) => [c, null]));
  Object.assign(email, {
    id: "00000000-0000-0000-0000-0000000c0001",
    org_id: ORG,
    job_id: JOB.fence,
    supplier_id: SUP.stratco,
    supplier_name: "Stratco",
    status: "sent",
    origin: "outlook",
    source_business_event_id: "00000000-0000-0000-0000-0000000c0002",
    subject: "Material Order Ref SWF-261586",
    body_text: OUTLOOK_BODY,
    built_body_text: OUTLOOK_BODY,
    sent_at: sentAt,
    created_at: sentAt,
    updated_at: sentAt,
    to_emails: ["tradewa@stratcowa.com.au"],
    cc_emails: [],
    order_lines: [{ line_id: null, updated_at: null, text: "14 x panels", standing: false }],
    photo_ids: [],
    sent_to_emails: ["tradewa@stratcowa.com.au"],
    sent_cc_emails: [],
  });
  // The box the recording made (dispatch_v2_record_outlook_order).
  await addBox(db, JOB.fence, SUP.stratco);
  db.tables.dispatch_supplier_order_emails.push(email);
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(read.auto_fill, false);
  const shown = JSON.stringify(read);
  assertEquals(shown.includes('"from_outlook":true'), true);
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true }), 409, "ordered_from_outlook");
  assertEquals(db.tables.job_material_lines.length, 0);
  // Shaun's own Fill press is his choice and still works.
  const pressed = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals(pressed.added > 0, true);
});

// ── T20: the fill reads the job's frozen scope revision ─────────────────────

Deno.test("frozen: no frozen revision fills nothing and says why; the screen's own fill waits for one", async () => {
  const db = makeDb();
  db.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("Stratco");
  const err = await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence }), 409, "no_frozen_scope");
  assertEquals(err.message, "This job has no frozen scope to suggest lines from");
  const unfrozen = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(
    [unfrozen.auto_fill, unfrozen.can_suggest, unfrozen.scope_seal],
    [false, true, { state: "no_frozen_scope", revision_id: null, revision_number: null }],
  );
  // A draft revision is not frozen.
  await seal(db, JOB.fence, 1, { status: "draft" });
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence }), 409, "no_frozen_scope");
  assertEquals([db.tables.job_material_lines.length, db.tables.job_material_suppliers.length, db.tables.dispatch_v2_scope_fills.length], [0, 0, 0]);

  const frozen = await seal(db, JOB.fence, 2);
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(read.scope_seal, { state: "frozen", revision_id: frozen, revision_number: 2 });
  assertEquals(read.auto_fill, true);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
  assertEquals([out.added, out.scope_revision, out.notes], [1, { id: frozen, revision_number: 2 }, []]);
  assertOnlyV2Writes(db);
});

Deno.test("frozen: the lines come from the frozen revision, not a scope saved since, and the fill says so", async () => {
  const db = makeDb();
  const fence = db.tables.jobs.find((j: any) => j.id === JOB.fence)!;
  fence.scope_json = fenceScope("Stratco");
  const frozen = await seal(db, JOB.fence, 1);
  // Saved again in the tool, not frozen again: three panels, and Metroll.
  fence.scope_json = {
    ...fenceScope("Metroll"),
    job: { ...fenceScope("Metroll").job, runs: [{ name: "Rear", panels: [{ height: 1800, retaining: 0 }, { height: 1800, retaining: 0 }, { height: 1800, retaining: 0 }] }] },
  };
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals(out.lines.map((l: any) => [l.quantity, l.supplier_id, l.scope_revision_id]), [[2, SUP.stratco, frozen]]);
  assertEquals(out.notes, [
    "The job's scope was changed after revision 1 was frozen. These lines come from revision 1: freeze the scope again to order the change.",
  ]);
});

Deno.test("frozen: the latest frozen revision is used, and the accepted one wins over it", async () => {
  const db = makeDb();
  const fence = db.tables.jobs.find((j: any) => j.id === JOB.fence)!;
  fence.scope_json = fenceScope("Stratco");
  const first = await seal(db, JOB.fence, 1, { status: "superseded" });
  fence.scope_json = fenceScope("Metroll");
  const second = await seal(db, JOB.fence, 2);
  const latest = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals([latest.scope_revision.id, latest.supplier?.supplier_id], [second, SUP.metroll]);

  // The quote accepted revision 1: the order is revision 1's, even after the
  // refreeze to revision 2 (Context's D1 fix F3).
  const db2 = makeDb();
  db2.tables.scope_revisions = structuredClone(db.tables.scope_revisions);
  const job2 = db2.tables.jobs.find((j: any) => j.id === JOB.fence)!;
  job2.scope_json = fence.scope_json;
  job2.pricing_json = fence.pricing_json;
  job2.expected_costs = { scope_revision_id: first };
  const accepted = await call(db2, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals([accepted.scope_revision, accepted.supplier?.supplier_id], [{ id: first, revision_number: 1 }, SUP.stratco]);
  assert(accepted.lines.every((l: any) => l.scope_revision_id === first && l.scope_revision_number === 1));

  // An acceptance chain that cannot be proved orders nothing.
  const db3 = makeDb();
  db3.tables.scope_revisions = structuredClone(db.tables.scope_revisions);
  const job3 = db3.tables.jobs.find((j: any) => j.id === JOB.fence)!;
  job3.scope_json = fence.scope_json;
  db3.tables.run_acceptances = [{ job_id: JOB.fence, status: "accepted", job_document_id: null }];
  await refused(call(db3, "dispatch_v2_suggest_draft", { job_id: JOB.fence }), 409, "accepted_quote_unproven");
  assertEquals(db3.tables.job_material_lines, []);
});

Deno.test("frozen: a sealed record whose text is not what was sealed is never read", async () => {
  const db = makeDb();
  db.tables.jobs.find((j: any) => j.id === JOB.patio)!.scope_json = patioRecord();
  await seal(db, JOB.patio);
  const row = db.tables.scope_revisions[0];
  row.scope_canonical_text = row.scope_canonical_text.replace("Trimdek", "Spandek");
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio }), 409, "scope_identity_unverified");
  assertEquals(db.tables.job_material_lines, []);
});

Deno.test("frozen: a failed revision read is unknown on the panel and refuses the fill, never fills from the job", async () => {
  const db = makeDb();
  db.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("Stratco");
  await seal(db, JOB.fence);
  db.failures.add("select:scope_revisions");
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals([read.auto_fill, read.scope_seal.state], [false, "unknown"]);
  const error = await assertRejects(
    () => call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence }),
    DispatchMaterialsError,
  ) as DispatchMaterialsError;
  assertEquals(error.status, 500);
  assertEquals(db.tables.job_material_lines, []);
});

Deno.test("frozen: every fence line carries the revision's id and number; the fill record names it", async () => {
  const db = makeDb();
  db.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = {
    tool: "fence",
    job: {
      profile: "Neetascreen",
      colour: "Paperbark",
      supplier: "Stratco",
      gates: [{ type: "pedestrian", width: 900, height: 1800 }],
      runs: [{ name: "Rear", panels: [{ height: 1800, retaining: 150 }, { height: 1800, retaining: 0 }] }],
    },
  };
  const revision = await seal(db, JOB.fence, 3);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assert(out.added > 2);
  for (const line of out.lines) {
    assertEquals([line.scope_revision_id, line.scope_revision_number, line.scope_line_id], [revision, 3, null]);
  }
  for (const stored of db.tables.job_material_lines) {
    assertEquals(
      [stored.source, stored.source_kind, stored.source_version_id, stored.source_version, stored.source_line_id],
      ["scope", "fence_scope_revision", revision, "3", null],
    );
  }
  assertEquals(db.tables.dispatch_v2_scope_fills.map((f: any) => [f.auto, f.scope_revision_id, f.supplier_id]), [
    [false, revision, SUP.stratco],
  ]);
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(read.scope_filled.scope_revision_id, revision);
  assertEquals(read.scope_seal, null);
  assert(read.suppliers[0].lines.every((l: any) => l.scope_revision_id === revision));
  assertOnlyV2Writes(db);
});

// A Scope Engine patio record (scope-engine-v2 jobsystem.ts): its sealed
// lines, each with the engine's id and, once the tool writes it, the supplier
// its order put the line under.
function patioRecord() {
  return {
    tool: "patio-scoper",
    version: "2.0",
    lines: [
      { id: "SL-roof", description: "Trimdek roof sheet 4,600", quantity: 10, unit: "sheet", colour: "Surfmist", supplierId: "stratco", supplierName: "Stratco" },
      { id: "SL-post", description: "100x100 SHS post 2,900", quantity: 3, unit: "length", colour: null, supplierId: "metroll", supplierName: "Metroll" },
      { id: "SL-beam", description: "C150 beam 7,400", quantity: 2, unit: "length", colour: null, supplierId: "stratco", supplierName: "Stratco" },
      { id: "SL-fix", description: "Tek screws 14g x 22", quantity: 200, unit: "each", colour: null, supplier: "office" },
      { id: "SL-tbc", description: "Patioline gutter 7,400", quantity: null, unit: "length", colour: null, supplierId: "supplier-to-confirm", supplierName: "Supplier to confirm" },
      { id: "SL-ready", description: "Concrete 20 MPa", quantity: 1, unit: "m3", colour: null, supplierId: "wa-ready-mix", supplierName: "Ready-mix concrete (Perth batching plant)" },
      { id: "SL-old", description: "Downpipe 90mm", quantity: 2, unit: "length", colour: null },
      { id: "SL-post", description: "Second line with the same engine id", quantity: 1, unit: "each", colour: null },
    ],
  };
}

Deno.test("frozen patio: lines go into the box of the supplier the engine's order names, with their engine ids", async () => {
  const db = makeDb();
  db.tables.jobs.find((j: any) => j.id === JOB.patio)!.scope_json = patioRecord();
  const revision = await seal(db, JOB.patio, 8);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  assertEquals(
    out.lines.map((l: any) => [l.description, l.supplier_id, l.scope_line_id, l.scope_revision_id, l.scope_revision_number]),
    [
      ["Trimdek roof sheet 4,600", SUP.stratco, "SL-roof", revision, 8],
      ["100x100 SHS post 2,900", SUP.metroll, "SL-post", revision, 8],
      ["C150 beam 7,400", SUP.stratco, "SL-beam", revision, 8],
      ["Patioline gutter 7,400", null, "SL-tbc", revision, 8],
      ["Concrete 20 MPa", null, "SL-ready", revision, 8],
      ["Downpipe 90mm", null, "SL-old", revision, 8],
      // The engine id is kept once per fill (job_material_lines_source_line_once).
      ["Second line with the same engine id", null, null, revision, 8],
    ],
  );
  assert(db.tables.job_material_lines.every((l: any) => l.source_kind === "patio_scope_revision"));
  assertEquals(db.tables.job_material_suppliers.map((b: any) => b.supplier_id), [SUP.stratco, SUP.metroll]);
  // Split across boxes: no single box, and the notes say where the lines went.
  assertEquals(out.supplier, null);
  assertEquals(out.suppliers.map((b: any) => [b.supplier_id, b.lines]), [[SUP.stratco, 2], [SUP.metroll, 1]]);
  assertEquals(out.notes, [
    "The scope names Ready-mix concrete (Perth batching plant) as the supplier, which has no approved order email. Its 1 line is on the draft list: add a supplier and move it in.",
    "2 lines went into the Stratco (WA) Pty Ltd box.",
    "1 line went into the Metroll Perth box.",
  ]);
  assertEquals(db.tables.dispatch_v2_scope_fills.map((f: any) => [f.supplier_id, f.scope_supplier, f.scope_revision_id]), [
    [null, null, revision],
  ]);
  assertOnlyV2Writes(db);
});

Deno.test("frozen patio: lines sealed before the engine wrote a supplier stay on the draft list, as before", async () => {
  const db = makeDb();
  const record = patioRecord();
  db.tables.jobs.find((j: any) => j.id === JOB.patio)!.scope_json = {
    ...record,
    lines: record.lines.map(({ supplierId: _id, supplierName: _name, ...rest }: any) => rest),
  };
  await seal(db, JOB.patio);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  assertEquals(out.added, 7);
  assertEquals([out.supplier, out.suppliers, out.notes], [null, [], []]);
  assert(out.lines.every((l: any) => l.supplier_id === null));
  assertEquals(db.tables.job_material_suppliers, []);
  // The patio fill is a press, never on its own.
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio, auto: true }), 409, "no_auto_fill");
});

Deno.test("frozen patio: the catalogue's bd-metals and cmi ids find their approved order emails", async () => {
  const { dispatchV2MatchScopeSupplier } = await import("./dispatch_v2_fence_scope.ts");
  const approved = ["B&D Metals Group", "CMI (Combined Metal Industries)", "Lysaght", "Metroll Perth", "Stratco WA", "Bondor"];
  assertEquals(
    ["bd-metals", "cmi", "lysaght", "metroll", "stratco", "bondor", "wa-ready-mix"].map((id) => dispatchV2MatchScopeSupplier(id, approved)),
    ["B&D Metals Group", "CMI (Combined Metal Industries)", "Lysaght", "Metroll Perth", "Stratco WA", "Bondor", null],
  );
});

// ── S08: the list follows a newer sealed revision ───────────────────────────

// Seal the job's scope again as freeze_scope does: the earlier frozen
// revision becomes superseded, the new one is frozen.
async function sealAgain(db: ReturnType<typeof makeDb>, jobId: string, n: number) {
  for (const r of db.tables.scope_revisions) {
    if (r.job_id === jobId && r.status === "frozen") r.status = "superseded";
  }
  return await seal(db, jobId, n);
}

Deno.test("S08: a newer sealed revision refills the list when nothing went out; typed lines stay; the read warns first", async () => {
  const db = makeDb();
  const fence = db.tables.jobs.find((j: any) => j.id === JOB.fence)!;
  fence.scope_json = fenceScope("Stratco");
  const first = await seal(db, JOB.fence, 1);
  const filled = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals(filled.lines.map((l: any) => [l.quantity, l.scope_revision_number]), [[2, 1]]);
  await addLine(db, JOB.fence, 9, { description: "Gate hinge we always add" });
  const up = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(up.scope_changed, null);
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence }), 409, "lines_exist");

  // The scope is changed in the tool and sealed again as revision 2.
  fence.scope_json = {
    ...fenceScope("Stratco"),
    job: { ...fenceScope("Stratco").job, runs: [{ name: "Rear", panels: [{ height: 1800, retaining: 0 }, { height: 1800, retaining: 0 }, { height: 1800, retaining: 0 }] }] },
  };
  const second = await sealAgain(db, JOB.fence, 2);
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(read.scope_changed, {
    lines_revision_numbers: [1],
    revision_id: second,
    revision_number: 2,
    can_refill: true,
    message: "Scope changed since these lines: they came from revision 1, and the order now follows revision 2. Press Fill from the scope to refill them from revision 2.",
  });
  // The screen never refills on its own.
  assertEquals(read.auto_fill, false);
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true }), 409, "already_filled");
  db.tables.dispatch_v2_scope_fills = [];
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true }), 409, "lines_exist");
  assertEquals(db.tables.job_material_lines.filter((l: any) => l.source_version_id === second), []);

  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals([out.added, out.scope_revision, out.refilled], [1, { id: second, revision_number: 2 }, { from_revision_numbers: [1], replaced: 1 }]);
  assertEquals(out.notes[0], "Refilled from revision 2: the 1 line from revision 1 was replaced.");
  const lines = db.tables.job_material_lines;
  assertEquals(
    lines.map((l: any) => [l.description, l.quantity, l.source_version_id ?? null]).sort((a: any, b: any) => String(a[0]).localeCompare(String(b[0]))),
    [
      ["1800H standard width panels with 2400H posts", 3, second],
      ["Gate hinge we always add", 1, null],
    ],
  );
  assert(!lines.some((l: any) => l.source_version_id === first), "no line from revision 1 is left");
  // The fill record (taken off above) is written again, naming revision 2.
  assertEquals(db.tables.dispatch_v2_scope_fills.map((f: any) => [f.scope_revision_id, f.lines_added, f.auto]), [[second, 1, false]]);
  const after = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals([after.scope_changed, after.scope_filled.scope_revision_id], [null, second]);
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence }), 409, "lines_exist");
  assertOnlyV2Writes(db);
});

Deno.test("S08: a line that went out on an order is never changed; the read and the press say the scope changed", async () => {
  const db = makeDb();
  const fence = db.tables.jobs.find((j: any) => j.id === JOB.fence)!;
  fence.scope_json = fenceScope("Stratco");
  await seal(db, JOB.fence, 1);
  await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  // The panel line went out on a sent order email.
  const sent = db.tables.job_material_lines[0];
  sent.dispatch_order_email_id = uuid("ee", 1);
  const before = structuredClone(db.tables.job_material_lines);
  fence.scope_json = { ...fenceScope("Stratco"), job: { ...fenceScope("Stratco").job, colour: "Monument" } };
  const second = await sealAgain(db, JOB.fence, 2);
  const words = "Scope changed since these lines: they came from revision 1, and the order now follows revision 2. An order already went out from these lines, so they were not refilled. Check that order against revision 2.";
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(read.scope_changed, {
    lines_revision_numbers: [1],
    revision_id: second,
    revision_number: 2,
    can_refill: false,
    message: words,
  });
  const err = await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence }), 409, "scope_changed");
  assertEquals(err.message, words);
  assertEquals(db.tables.job_material_lines, before);
  // A line on a purchase order is held the same way.
  const db2 = makeDb();
  db2.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = fenceScope("Stratco");
  await seal(db2, JOB.fence, 1);
  await call(db2, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  db2.tables.job_material_lines[0].purchase_order_id = uuid("ef", 1);
  db2.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = { ...fenceScope("Stratco"), job: { ...fenceScope("Stratco").job, colour: "Monument" } };
  await sealAgain(db2, JOB.fence, 2);
  await refused(call(db2, "dispatch_v2_suggest_draft", { job_id: JOB.fence }), 409, "scope_changed");
  assertEquals(db2.tables.job_material_lines[0].source_version, "1");
});

Deno.test("S08 patio: the refill takes the newer revision's engine lines into their boxes; lines typed in are kept", async () => {
  const db = makeDb();
  const patio = db.tables.jobs.find((j: any) => j.id === JOB.patio)!;
  patio.scope_json = patioRecord();
  const eight = await seal(db, JOB.patio, 8);
  const first = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  assertEquals(first.added, 7);
  await addLine(db, JOB.patio, 9, { description: "Silicone we always add" });
  const record = patioRecord();
  patio.scope_json = {
    ...record,
    lines: record.lines.map((l: any) => l.id === "SL-roof" ? { ...l, quantity: 12 } : l),
  };
  const nine = await sealAgain(db, JOB.patio, 9);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  assertEquals([out.added, out.refilled], [7, { from_revision_numbers: [8], replaced: 7 }]);
  const scopeLines = db.tables.job_material_lines.filter((l: any) => l.source === "scope");
  assert(scopeLines.every((l: any) => l.source_version_id === nine && l.source_version === "9"));
  assert(!db.tables.job_material_lines.some((l: any) => l.source_version_id === eight));
  assertEquals(
    scopeLines.filter((l: any) => l.source_line_id === "SL-roof").map((l: any) => [l.quantity, l.supplier_id]),
    [[12, SUP.stratco]],
  );
  assertEquals(db.tables.job_material_lines.filter((l: any) => l.source !== "scope").map((l: any) => l.description), ["Silicone we always add"]);
  // The boxes the first fill made are reused, never made twice.
  assertEquals(db.tables.job_material_suppliers.map((b: any) => b.supplier_id), [SUP.stratco, SUP.metroll]);
  // The job's one fill record now names revision 9.
  assertEquals(db.tables.dispatch_v2_scope_fills.map((f: any) => [f.scope_revision_id, f.lines_added]), [[nine, 7]]);
  assertEquals((await get(db, "dispatch_v2_materials", { job_id: JOB.patio })).scope_changed, null);
  assertOnlyV2Writes(db);
});

// ── B3: the fence fill writes each line's sealed source and unit ─────────────

Deno.test("B3 fence fill: each row carries its sealed line and unit; Shaun's email wording is unchanged", async () => {
  const db = makeDb();
  const fence = db.tables.jobs.find((j: any) => j.id === JOB.fence)!;
  fence.scope_json = {
    ...fenceScope("Stratco"),
    tool: "fencing",
    job: { ...fenceScope("Stratco").job, gates: [{ type: "pedestrian", width: 900, height: 1800 }] },
    lines: [
      { id: "SL-kit", description: "Panel kit 1800H + 2400H post (2380mm wide)", quantity: 2, unit: "each", category: "panels", supplierName: "Stratco" },
      { id: "SL-gate", description: "Gate 1: pedestrian gate parts (900mm)", quantity: 1, unit: "each", category: "gates", supplierName: "Stratco" },
      { id: "SL-gpost", description: "50x50mm SHS gate post, L2400mm ×2 (gate 1)", quantity: 2, unit: "each", category: "gates", supplierName: "Stratco" },
    ],
  };
  const revision = await seal(db, JOB.fence, 5);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence });
  assertEquals(out.added, 6);
  const rows = [...db.tables.job_material_lines].sort((a: any, b: any) => a.position - b.position);
  assertEquals(rows.map((r: any) => [r.description, r.quantity, r.unit, r.source_line_id, r.source_version_id]), [
    ["1800H standard width panels with 2400H posts", 2, "each", "SL-kit", revision],
    ["gate posts", 2, "each", "SL-gpost", revision],
    ["gate stiles pair", 1, "each", "SL-gate#1/4", revision],
    ["1800mm Colorbond infill sheets", 2, "each", "SL-gate#2/4", revision],
    ["Lokklatch kit", 1, "each", "SL-gate#3/4", revision],
    ["long rail", 1, "each", "SL-gate#4/4", revision],
  ]);
  // The planted fault: a row with no sealed source is caught.
  const noSource = (rs: any[]) => rs.filter((r) => !r.source_line_id || !r.unit).map((r) => r.description);
  assertEquals(noSource(rows), []);
  assertEquals(noSource(rows.map((r: any, i: number) => (i === 4 ? { ...r, source_line_id: null } : r))), ["Lokklatch kit"]);
  // The order email reads as Shaun's always has: no unit in a fence line.
  const made = await makeEmail(db, JOB.fence, SUP.stratco);
  const body = String(made.email.body_text);
  assert(body.includes("2 x 1800H standard width panels with 2400H posts"), body);
  assert(body.includes("1 x Lokklatch kit"), body);
  assert(!/\beach x\b/.test(body), body);
  assertOnlyV2Writes(db);
});

// ── The sealed supplier split: Dispatch boxes equal the sealed supplier orders ──
// Go-live walk, 12 Nov 2026: a fence sealed its gate hardware (stiles, latch,
// rail) to one supplier and the panels, sheets and gate posts to another, but
// the fill put every line in the box of the one supplier typed on the scope.

Deno.test("supplier split: a fence's lines go in the box of their own sealed line's supplier, line for line", async () => {
  const init = bdSeed();
  const fw = { approved: uuid("c9", 1), contact: uuid("c9", 2) };
  init.suppliers.push({
    id: fw.contact,
    org_id: ORG,
    name: "Fencing Warehouse WA Pty Ltd",
    email: "xero-sync-owns-this@example.test",
    is_active: true,
    xero_contact_id: "xc-fw",
  });
  init.dispatch_approved_supplier_emails.push({
    id: fw.approved,
    org_id: ORG,
    name: "Fencing Warehouse WA",
    used_for: "fencing",
    to_emails: ["orders@fw.test"],
    cc_emails: [],
    active: true,
    on_account: false,
    approved_by: "Shaun",
    approved_on: "2026-10-23",
  });
  init.dispatch_approved_supplier_email_links.push({ supplier_id: fw.contact, approved_id: fw.approved, org_id: ORG });
  const RR = { supplierId: "r-and-r-fencing", supplierName: "R&R Fencing" };
  const FW = { supplierId: "fencing-warehouse-wa", supplierName: "Fencing Warehouse WA" };
  const sealedLines = [
    { id: "SL-kit", description: "Panel kit 1800H + 2400H post (2380mm wide)", quantity: 2, unit: "each", category: "panels", ...RR },
    { id: "SL-stile", description: "Gate 1: gate stile pair 1760mm, Monument", quantity: 1, unit: "each", category: "gates", ...FW },
    { id: "SL-latch", description: "Gate 1: Lokklatch Deluxe latch and Truclose regular hinge pair", quantity: 1, unit: "each", category: "gates", ...FW },
    { id: "SL-rail", description: "Gate 1: long rail 3125mm (gate frame)", quantity: 1, unit: "each", category: "gates", ...FW },
    { id: "SL-sheet", description: "Gate 1: 1800mm infill sheet, Sameside, Monument ×2", quantity: 2, unit: "each", category: "gates", ...RR },
    { id: "SL-gpost", description: "50x50mm SHS gate post, L2400mm ×2 (gate 1)", quantity: 2, unit: "each", category: "gates", ...RR },
  ];
  const scopeWith = (lines: any[]) => ({
    ...fenceScope("RNR"),
    tool: "fencing",
    job: { ...fenceScope("RNR").job, gates: [{ type: "pedestrian", width: 900, height: 1800 }] },
    lines,
  });

  const db = makeDb(structuredClone(init));
  db.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = scopeWith(sealedLines);
  await seal(db, JOB.fence);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
  assertEquals(out.added, 6);
  const rows = [...db.tables.job_material_lines].sort((a: any, b: any) => a.position - b.position);
  assertEquals(rows.map((r: any) => [r.description, r.source_line_id, r.supplier_id]), [
    ["1800H standard width panels with 2400H posts", "SL-kit", BD.rr],
    ["gate posts", "SL-gpost", BD.rr],
    ["gate stiles pair", "SL-stile", fw.contact],
    ["1800mm Colorbond infill sheets", "SL-sheet", BD.rr],
    ["Lokklatch kit", "SL-latch", fw.contact],
    ["long rail", "SL-rail", fw.contact],
  ]);
  assertEquals(
    db.tables.job_material_suppliers.map((b: any) => b.supplier_id).sort(),
    [BD.rr, fw.contact].sort(),
  );

  // A gate part the sealed order does not place is held on the draft list,
  // not guessed into either box.
  const db2 = makeDb(structuredClone(init));
  db2.tables.jobs.find((j: any) => j.id === JOB.fence)!.scope_json = scopeWith(
    sealedLines.map((l) => l.id === "SL-rail" ? { ...l, supplierId: null, supplierName: null } : l),
  );
  await seal(db2, JOB.fence);
  const out2 = await call(db2, "dispatch_v2_suggest_draft", { job_id: JOB.fence, auto: true });
  const rail = db2.tables.job_material_lines.find((r: any) => r.description === "long rail")!;
  assertEquals([rail.source_line_id, rail.supplier_id], ["SL-rail", null]);
  assert(
    out2.notes.includes("1 line has no supplier in the sealed order, so it is on the draft list: long rail."),
    JSON.stringify(out2.notes),
  );
  // Only Dispatch's own tables are written (the seed here adds contacts, so
  // assertOnlyV2Writes' default-seed contact check does not apply).
  for (const w of [...db.writes(), ...db2.writes()]) {
    assert(V2_WRITABLE.has(w.table), `wrote ${w.kind} ${w.table}`);
  }
});

// ── Boxes and the main tick ─────────────────────────────────────────────────

Deno.test("boxes: add flags a supplier with no approved email; the X takes a box off with its lines", async () => {
  const db = makeDb();
  const plain = await addBox(db, JOB.fence, SUP.plain);
  assertEquals(plain.supplier.send_blocked.code, "no_approved_email");
  const stratco = await addBox(db, JOB.fence, SUP.stratco);
  assertEquals(stratco.supplier.send_blocked, null);
  assertEquals(stratco.supplier.approved_email.cc, [
    "tony.bacich@stratcowa.com.au",
  ]);
  assertEquals((await addBox(db, JOB.fence, SUP.stratco)).unchanged, true);
  // A retired approved entry counts as none.
  assertEquals(
    (await addBox(db, JOB.fence, SUP.oldlink)).supplier.send_blocked.code,
    "no_approved_email",
  );
  await refused(addBox(db, JOB.fence, SUP.inactive), 409, "supplier_inactive");
  await refused(addBox(db, JOB.fence, SUP.otherOrg), 404, "supplier_not_found");
  await addLine(db, JOB.fence, 1, { supplier_id: SUP.stratco, description: "x" });
  // Shaun, 12 Nov 2026: a box with lines comes off too, lines and all.
  const out = await call(db, "dispatch_v2_remove_supplier", {
    job_id: JOB.fence,
    supplier_id: SUP.stratco,
  });
  assertEquals(out.removed, {
    lines: 1,
    photos_deleted: 0,
    photos_kept: 0,
    held_emails_discarded: 0,
    sent_emails_kept: 0,
  });
  assertEquals(
    db.tables.job_material_lines.filter((l) => l.supplier_id === SUP.stratco),
    [],
  );
  await call(db, "dispatch_v2_remove_supplier", {
    job_id: JOB.fence,
    supplier_id: SUP.plain,
  });
  assertEquals(
    db.tables.job_material_suppliers.map((b) => b.supplier_id),
    [SUP.oldlink],
  );
  // Gone already: nothing to do.
  assertEquals(
    (await call(db, "dispatch_v2_remove_supplier", {
      job_id: JOB.fence,
      supplier_id: SUP.stratco,
    })).unchanged,
    true,
  );
  assertOnlyV2Writes(db);
});

Deno.test("remove: the X discards the held email, deletes lines and unsent photos, keeps the sent email and its photo", async () => {
  const db = await fencingJob();
  // A first order to Stratco went, with one photo on it.
  const sentPhoto = await uploadPhoto(db, JOB.fence, SUP.stratco, "sent.jpg");
  await makeEmail(db, JOB.fence, SUP.stratco);
  const sent = db.tables.dispatch_supplier_order_emails.find((e: any) =>
    e.supplier_id === SUP.stratco
  )!;
  sent.status = "sent";
  sent.sent_at = "2026-11-05T01:00:00.000Z";
  sent.photo_ids = [sentPhoto.id];
  for (const line of db.tables.job_material_lines) {
    if (line.supplier_id === SUP.stratco) line.dispatch_order_email_id = sent.id;
  }
  // A second order is made up and held, with a new line and a new photo.
  await addLine(db, JOB.fence, 5, {
    supplier_id: SUP.stratco,
    description: "150mm long width plinths",
    quantity: 2,
  });
  const heldPhoto = await uploadPhoto(db, JOB.fence, SUP.stratco, "held.jpg");
  await makeEmail(db, JOB.fence, SUP.stratco);
  const held = db.tables.dispatch_supplier_order_emails.find((e: any) =>
    e.supplier_id === SUP.stratco && e.status === "draft"
  )!;
  const heldPath = db.tables.dispatch_material_photos.find((p: any) =>
    p.id === heldPhoto.id
  )!.storage_path;

  const out = await call(db, "dispatch_v2_remove_supplier", {
    job_id: JOB.fence,
    supplier_id: SUP.stratco,
  });
  assertEquals(out.removed, {
    lines: 4,
    photos_deleted: 1,
    photos_kept: 1,
    held_emails_discarded: 1,
    sent_emails_kept: 1,
  });
  // The box and its lines are gone; Metroll's box and line are untouched.
  assertEquals(
    db.tables.job_material_suppliers.map((b) => b.supplier_id),
    [SUP.metroll],
  );
  assertEquals(
    db.tables.job_material_lines.map((l) => l.supplier_id),
    [SUP.metroll],
  );
  // The held email is discarded; the sent one is kept as it was.
  assertEquals(held.status, "discarded");
  assertEquals(sent.status, "sent");
  // The sent photo is kept, now on the draft list; the held one is deleted
  // with its file.
  assertEquals(
    db.tables.dispatch_material_photos.map((p: any) => [p.id, p.supplier_id]),
    [[sentPhoto.id, null]],
  );
  assert(
    db.requests.some((r: any) =>
      r.table === "storage" && r.kind === "remove" && r.select === heldPath
    ),
    "the held photo's file is removed",
  );
  // The read: no Stratco box, and the sent email still listed for the panel.
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(read.suppliers.map((s: any) => s.supplier_id), [SUP.metroll]);
  assertEquals(read.main_supplier_id, SUP.metroll);
  assertEquals(read.unboxed_sent_emails.length, 1);
  assertEquals(read.unboxed_sent_emails[0].supplier_id, SUP.stratco);
  assertEquals(read.unboxed_sent_emails[0].email.id, sent.id);
  assertEquals(read.draft_list.photos.map((p: any) => p.id), [sentPhoto.id]);
  assertOnlyV2Writes(db);
});

Deno.test("remove: an order email sending now, or that may have gone, keeps the box", async () => {
  for (const status of ["sending", "send_unknown"]) {
    const db = await fencingJob();
    await makeEmail(db, JOB.fence, SUP.metroll);
    const row = db.tables.dispatch_supplier_order_emails.find((e: any) =>
      e.supplier_id === SUP.metroll
    )!;
    row.status = status;
    if (status === "sending") row.send_claimed_at = "2026-11-12T01:00:00.000Z";
    await refused(
      call(db, "dispatch_v2_remove_supplier", {
        job_id: JOB.fence,
        supplier_id: SUP.metroll,
      }),
      409,
      "supplier_email_sending",
    );
    assert(
      db.tables.job_material_suppliers.some((b) => b.supplier_id === SUP.metroll),
    );
    assertEquals(
      db.tables.job_material_lines.filter((l) => l.supplier_id === SUP.metroll)
        .length,
      1,
    );
    assertEquals(row.status, status);
  }
});

Deno.test("main tick: moves the standing lines to the ticked box; null clears it", async () => {
  const db = await fencingJob();
  const ticked = await call(db, "dispatch_v2_set_main_supplier", {
    job_id: JOB.fence,
    supplier_id: SUP.metroll,
  });
  assertEquals(ticked, {
    success: true,
    main_supplier_id: SUP.metroll,
    main_supplier_ticked: true,
  });
  const metroll = (await makeEmail(db, JOB.fence, SUP.metroll)).email;
  assertEquals(metroll.is_main_supplier, true);
  assertEquals(metroll.standing_lines_included, true);
  assert(metroll.body_text.includes("3. Fixings, Post Caps and Screws"));
  const stratco = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  assertEquals(stratco.standing_lines_included, false);
  assert(!stratco.body_text.includes("quickset"));
  const cleared = await call(db, "dispatch_v2_set_main_supplier", {
    job_id: JOB.fence,
    supplier_id: null,
  });
  assertEquals(cleared.main_supplier_id, SUP.stratco);
  assertEquals(cleared.main_supplier_ticked, false);
  assertEquals(
    db.tables.job_material_suppliers.filter((b) => b.is_main_supplier).length,
    0,
  );
});

// ── Photos ──────────────────────────────────────────────────────────────────

function jpegBase64(size = 64): string {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

Deno.test("photos: a small JPEG goes in a box privately; 3 MB or more and HEIC are refused", async () => {
  const db = makeDb();
  await addBox(db, JOB.fence, SUP.stratco);
  const up = await call(db, "dispatch_v2_upload_photo", {
    job_id: JOB.fence,
    supplier_id: SUP.stratco,
    file_name: "Nithin list.jpeg",
    data_base64: jpegBase64(),
  });
  assertEquals(up.photo.content_type, "image/jpeg");
  assertEquals(up.photo.file_name, "Nithin-list.jpg");
  assertEquals(up.photo.size_bytes, 64);
  assertEquals(db.files.size, 1);
  const link = await get(db, "dispatch_v2_photo_url", {
    job_id: JOB.fence,
    photo_id: up.photo.id,
  });
  assertEquals(link.expires_in_seconds, 600);
  assert(link.url.startsWith("https://storage.test/"));
  const big = await refused(
    call(db, "dispatch_v2_upload_photo", {
      job_id: JOB.fence,
      data_base64: "A".repeat(4_000_004),
    }),
    413,
    "photo_too_large",
  );
  assert(big.message.includes("MB"));
  const heic = btoa("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00");
  await refused(
    call(db, "dispatch_v2_upload_photo", { job_id: JOB.fence, data_base64: heic }),
    400,
    "photo_type_not_allowed",
  );
  // Moved to the draft list, then removed with its file.
  const moved = await call(db, "dispatch_v2_move_photo", {
    job_id: JOB.fence,
    photo_id: up.photo.id,
    supplier_id: null,
  });
  assertEquals(moved.photo.supplier_id, null);
  await call(db, "dispatch_v2_delete_photo", {
    job_id: JOB.fence,
    photo_id: up.photo.id,
  });
  assertEquals(db.tables.dispatch_material_photos.length, 0);
  assertEquals(db.files.size, 0);
});

// ── Make email ──────────────────────────────────────────────────────────────

Deno.test("make email: fencing main supplier, To and CC from the approved list plus fencing@", async () => {
  const db = await fencingJob();
  const made = await makeEmail(db, JOB.fence, SUP.stratco);
  const email = made.email;
  assertEquals(email.status, "draft");
  assertEquals(email.from, "admin@secureworkswa.com.au");
  assertEquals(email.to, ["tradewa@stratcowa.com.au"]);
  assertEquals(email.cc, [
    "tony.bacich@stratcowa.com.au",
    "fencing@secureworkswa.com.au",
  ]);
  assertEquals(email.subject, "Material Order Ref SWF-900001");
  assertEquals(email.is_main_supplier, true);
  assertEquals(email.standing_lines_included, true);
  assertEquals(email.edited, false);
  assertEquals(email.empty_detail_lines, []);
  assertEquals(made.missing, []);
  // The In stock line is left out.
  assert(!email.body_text.includes("Tek screws we have"));
  assert(
    email.body_text.endsWith(
      "3. 4 x bags of quickset\n\n4. Fixings, Post Caps and Screws as necessary\n\n\nPlease confirm when you can, thank you.",
    ),
  );
  assertEquals(email.line_count, 4);
  // Pressing again returns the same held email.
  const again = await makeEmail(db, JOB.fence, SUP.stratco);
  assertEquals([again.unchanged, again.email.id], [true, email.id]);
  // The non-main box: no standing lines.
  const metroll = (await makeEmail(db, JOB.fence, SUP.metroll)).email;
  assertEquals(metroll.standing_lines_included, false);
  assertEquals(
    metroll.body_text.split("\n").filter((l: string) => /^\d+\. /.test(l)),
    ["1. 2 x gate posts"],
  );
  assertEquals(metroll.cc, ["fencing@secureworkswa.com.au"]);
  assertOnlyV2Writes(db);
});

Deno.test("make email: a recognise-only address (Solarspan on Bondor, 11 Nov 2026) is never sent to or copied", async () => {
  const db = makeDb();
  const stratco = db.tables.dispatch_approved_supplier_emails.find((e) =>
    e.id === APPROVED.stratco
  )!;
  stratco.also_known_emails = ["wasales@brand.stratco.test"];
  await fencingJob(db);
  const made = await makeEmail(db, JOB.fence, SUP.stratco);
  assertEquals(made.email.to, ["tradewa@stratcowa.com.au"]);
  assertEquals(made.email.cc, [
    "tony.bacich@stratcowa.com.au",
    "fencing@secureworkswa.com.au",
  ]);
  assert(!JSON.stringify(made).includes("brand.stratco.test"));
});

Deno.test("make email: patio CCs patios@, repair CCs ses@, decking CCs patios@ and says it is open", async () => {
  const db = makeDb();
  for (const jobId of [JOB.patio, JOB.repair, JOB.decking]) {
    await addBox(db, jobId, SUP.metroll);
    await call(db, "dispatch_v2_save_line", {
      job_id: jobId,
      line: {
        id: crypto.randomUUID(),
        supplier_id: SUP.metroll,
        description: "Insulated roof panels",
        quantity: 6,
      },
    });
  }
  const patio = await makeEmail(db, JOB.patio, SUP.metroll);
  assertEquals(patio.email.cc, ["patios@secureworkswa.com.au"]);
  assertEquals(patio.email.standing_lines_included, false);
  assertEquals(patio.team_cc_open_question, null);
  const repair = await makeEmail(db, JOB.repair, SUP.metroll);
  assertEquals(repair.email.cc, ["ses@secureworkswa.com.au"]);
  assertEquals(repair.email.subject, "Material Order Ref SWR-900003");
  const decking = await makeEmail(db, JOB.decking, SUP.metroll);
  assertEquals(decking.email.cc, ["patios@secureworkswa.com.au"]);
  assert(decking.team_cc_open_question);
});

Deno.test("make email: no approved email, no lines and a bad date are refused", async () => {
  const db = makeDb();
  await addBox(db, JOB.fence, SUP.plain);
  await addLine(db, JOB.fence, 1, { supplier_id: SUP.plain, description: "x" });
  await refused(makeEmail(db, JOB.fence, SUP.plain), 409, "no_approved_email");
  await addBox(db, JOB.fence, SUP.stratco);
  await refused(makeEmail(db, JOB.fence, SUP.stratco), 409, "no_lines_to_order");
  await refused(
    makeEmail(db, JOB.fence, SUP.stratco, { delivery_date: "4/11/2026" }),
    400,
    "invalid_request",
  );
  assertEquals(db.tables.dispatch_supplier_order_emails.length, 0);
});

// ── Tweak 5: an order that is just a photo; Tweak 6: no Contact on pickup ──

async function uploadPhoto(
  db: ReturnType<typeof makeDb>,
  jobId: string,
  supplierId: string | null,
  name = "drawing.jpg",
) {
  return (await call(db, "dispatch_v2_upload_photo", {
    job_id: jobId,
    supplier_id: supplierId,
    file_name: name,
    data_base64: jpegBase64(),
  })).photo;
}

Deno.test("make email: a box with only a photo makes a photo-only email and sends it; the photo is not sent twice", async () => {
  const db = makeDb();
  await addBox(db, JOB.patio, SUP.metroll);
  // Nothing at all in the box: still refused, as before.
  await refused(makeEmail(db, JOB.patio, SUP.metroll), 409, "no_lines_to_order");
  const photo = await uploadPhoto(db, JOB.patio, SUP.metroll);
  const made = await makeEmail(db, JOB.patio, SUP.metroll, {
    delivery_date: "2026-11-10",
    fulfilment: "pickup",
  });
  assertEquals(made.photo_only, true);
  assertEquals(made.missing, []);
  const email = made.email;
  assertEquals(email.photo_ids, [photo.id]);
  assertEquals(email.line_count, 0);
  assertEquals(
    email.body_text,
    [
      "Hi Team, could we please order the following for pickup:",
      "",
      "Date: 10 November 2026",
      "Contact: (Jeremy)",
      "",
      "Materials Needed:",
      "",
      "Please see attached for materials needed.",
      "",
      "",
      "Please confirm when you can, thank you.",
    ].join("\n"),
  );
  const { sent, sender } = fakeSender();
  const real = await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
  }, ctx(sender));
  assertEquals([real.success, real.recorded, real.email.status], [true, true, "sent"]);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].attachments.length, 1);
  assert(sent[0].htmlBody.includes("Please see attached for materials needed."));
  // The photo went: the box has nothing left to order.
  await refused(makeEmail(db, JOB.patio, SUP.metroll), 409, "no_lines_to_order");
  // A new photo is a new order, and the photo already sent is left off it.
  const second = await uploadPhoto(db, JOB.patio, SUP.metroll, "more.jpg");
  const next = await makeEmail(db, JOB.patio, SUP.metroll);
  assertEquals(next.email.photo_ids, [second.id]);
  assertOnlyV2Writes(db);
});

Deno.test("make email: a fencing main supplier with only a photo gets no standing lines", async () => {
  const db = makeDb();
  await addBox(db, JOB.fence, SUP.stratco);
  await uploadPhoto(db, JOB.fence, SUP.stratco);
  const made = await makeEmail(db, JOB.fence, SUP.stratco);
  assertEquals(made.photo_only, true);
  assertEquals(made.email.is_main_supplier, true);
  assertEquals(made.email.standing_lines_included, false);
  assert(!made.email.body_text.includes("quickset"));
  assert(!made.email.body_text.includes("Fixings"));
});

Deno.test("make email: photos and lines number the lines, then say Please also see attached", async () => {
  const db = await fencingJob();
  await uploadPhoto(db, JOB.fence, SUP.stratco);
  const made = await makeEmail(db, JOB.fence, SUP.stratco);
  assertEquals(made.photo_only, false);
  assertEquals(made.email.photo_ids.length, 1);
  assert(made.email.body_text.endsWith(
    "4. Fixings, Post Caps and Screws as necessary\n\nPlease also see attached.\n\n\nPlease confirm when you can, thank you.",
  ));
  // Metroll's box has a line and no photo: exactly as before.
  const metroll = await makeEmail(db, JOB.fence, SUP.metroll);
  assert(!metroll.email.body_text.includes("attached"));
});

Deno.test("send: a photo-only email with its photo taken off is refused before anything goes", async () => {
  const db = makeDb();
  await addBox(db, JOB.patio, SUP.metroll);
  await uploadPhoto(db, JOB.patio, SUP.metroll);
  const email = (await makeEmail(db, JOB.patio, SUP.metroll)).email;
  const emptied = (await call(db, "dispatch_v2_save_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
    photo_ids: [],
  })).email;
  const { sent, sender } = fakeSender();
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: emptied.updated_at,
    }, ctx(sender)),
    409,
    "nothing_to_order",
  );
  assertEquals(sent.length, 0);
});

Deno.test("Tweak 6: a pickup with no client phone is made and sent with no Contact line; a delivery still needs it", async () => {
  const db = await fencingJob();
  const row = db.tables.jobs.find((j: any) => j.id === JOB.fence)!;
  row.client_phone = null;
  row.client_name = null;
  const { sent, sender } = fakeSender();
  const pickup = await makeEmail(db, JOB.fence, SUP.stratco, { fulfilment: "pickup" });
  assertEquals(pickup.missing, []);
  assert(!pickup.email.body_text.includes("Contact:"));
  assertEquals(pickup.email.empty_detail_lines, []);
  const went = await call(db, "dispatch_v2_send_email", {
    email_id: pickup.email.id,
    expected_updated_at: pickup.email.updated_at,
  }, ctx(sender));
  assertEquals(went.email.status, "sent");
  assert(!sent[0].htmlBody.includes("Contact:"));
  // Delivery: the Contact line stays, and an empty one stops the send.
  const delivery = await makeEmail(db, JOB.fence, SUP.metroll, { fulfilment: "delivery" });
  assertEquals(delivery.missing, ["contact"]);
  assert(delivery.email.body_text.includes("\nContact:\n"));
  const missing = await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: delivery.email.id,
      expected_updated_at: delivery.email.updated_at,
    }, ctx(sender)),
    409,
    "email_details_missing",
  );
  assertEquals(missing.body.missing, ["contact"]);
  assertEquals(sent.length, 1);
});

Deno.test("make email: pickup says so, has no Address line and a rebuild keeps it", async () => {
  const db = await fencingJob();
  await refused(
    makeEmail(db, JOB.fence, SUP.stratco, { fulfilment: "collect" }),
    400,
    "invalid_request",
  );
  assertEquals(db.tables.dispatch_supplier_order_emails.length, 0);
  const made = await makeEmail(db, JOB.fence, SUP.stratco, {
    fulfilment: "pickup",
  });
  const email = made.email;
  assert(email.body_text.startsWith(
    "Hi Team, could we please order the following for pickup:",
  ));
  assert(!email.body_text.includes("Address:"));
  assertEquals(email.fulfilment, "pickup");
  assertEquals(made.missing.includes("address"), false);
  // A rebuild with no choice keeps pickup.
  const rebuilt = await makeEmail(db, JOB.fence, SUP.stratco, {
    rebuild: true,
  });
  assertEquals(rebuilt.email.fulfilment, "pickup");
  assert(!rebuilt.email.body_text.includes("Address:"));
  // A rebuild that says delivery switches back and puts the address in.
  const back = await makeEmail(db, JOB.fence, SUP.stratco, {
    rebuild: true,
    fulfilment: "delivery",
  });
  assertEquals(back.email.fulfilment, "delivery");
  assert(back.email.body_text.startsWith(
    "Hi Team, could we please order the following for delivery:",
  ));
  assert(back.email.body_text.includes("Address:"));
  assertOnlyV2Writes(db);
});

Deno.test("make email: a new box starts on ASAP, says Date: ASAP and saves nothing new", async () => {
  const db = await fencingJob();
  const box = () =>
    db.tables.job_material_suppliers.find((b) => b.supplier_id === SUP.stratco)!;
  assertEquals(box().order_date_mode, "asap");
  // The helper sends a date unless told not to. A new screen sends
  // date_mode: null (the box's own choice) and no date.
  const made = await makeEmail(db, JOB.fence, SUP.stratco, {
    delivery_date: null,
    date_mode: null,
  });
  assert(made.email.body_text.includes("\nDate: ASAP\n"));
  assertEquals(made.date_mode, "asap");
  assertEquals(made.date_mode_saved, null);
  assertEquals(made.missing.includes("date"), false);
  assertEquals(made.email.delivery_date, null);
  // Already ASAP: the box is not written, no audit line.
  assertEquals(box().order_date_mode_set_at ?? null, null);
  assertEquals(db.tables.job_events.length, 0);
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  const stratco = read.suppliers.find((s: any) => s.supplier_id === SUP.stratco);
  assertEquals(stratco.date_mode, {
    mode: "asap",
    sent_mode: null,
    set_at: null,
    set_by_email: null,
    derived: false,
  });
  // An explicit "asap" on a box already on ASAP saves nothing either.
  const again = await makeEmail(db, JOB.fence, SUP.metroll, {
    delivery_date: null,
    date_mode: "asap",
  });
  assertEquals([again.date_mode, again.date_mode_saved], ["asap", null]);
  assertEquals(db.tables.job_events.length, 0);
  assertOnlyV2Writes(db);
});

Deno.test("make email: an older screen with no choice and no date keeps the blank Date line", async () => {
  const db = await fencingJob();
  const box = () =>
    db.tables.job_material_suppliers.find((b) => b.supplier_id === SUP.stratco)!;
  // The box is on ASAP, but date_mode is left out: exactly as before piece C.
  assertEquals(box().order_date_mode, "asap");
  const made = await makeEmail(db, JOB.fence, SUP.stratco, { delivery_date: null });
  assertEquals(made.date_mode, "date");
  assertEquals(made.date_mode_saved, null);
  assert(!made.email.body_text.includes("Date: ASAP"));
  assert(made.missing.includes("date"), "the send is refused without a date");
  // The box's choice is neither used nor saved.
  assertEquals([box().order_date_mode, box().order_date_mode_set_at ?? null], ["asap", null]);
  assertEquals(db.tables.job_events.length, 0);
  assertOnlyV2Writes(db);
});

Deno.test("make email: a changed choice is saved on the box after the email lands, with an audit line", async () => {
  const db = await fencingJob();
  const made = await makeEmail(db, JOB.fence, SUP.stratco, {
    date_mode: "date",
    delivery_date: "2026-11-04",
  });
  assertEquals(made.date_mode_saved, true);
  // The order of writes: the email row first, then the box's choice, then
  // the audit line. The box write is scoped to the org.
  const writes = db.writes();
  const emailAt = writes.findIndex((w) =>
    w.table === "dispatch_supplier_order_emails" && w.kind === "insert"
  );
  const boxAt = writes.findLastIndex((w) =>
    w.table === "job_material_suppliers" && w.kind === "update"
  );
  const auditAt = writes.findIndex((w) => w.table === "job_events");
  assert(emailAt >= 0 && emailAt < boxAt && boxAt < auditAt, JSON.stringify(writes));
  assert(
    writes[boxAt].filters.some(([op, c, v]) => op === "eq" && c === "org_id" && v === ORG),
    "the box write carries the org",
  );
  assertEquals(db.tables.job_events.length, 1);
  const event = db.tables.job_events[0];
  assertEquals(event.job_id, JOB.fence);
  assertEquals(event.event_type, "dispatch_v2_date_mode_set");
  assertEquals(
    [event.detail_json.from, event.detail_json.to, event.detail_json.via],
    ["asap", "date", "make_email"],
  );
  assertEquals(event.detail_json.supplier_id, SUP.stratco);
  assertOnlyV2Writes(db);
});

Deno.test("make email: when the email cannot be made, the box keeps its choice", async () => {
  const db = await fencingJob();
  db.failures.add("insert:dispatch_supplier_order_emails");
  await assertRejects(() =>
    makeEmail(db, JOB.fence, SUP.stratco, { date_mode: "date", delivery_date: "2026-11-04" })
  );
  const box = db.tables.job_material_suppliers.find((b) => b.supplier_id === SUP.stratco)!;
  assertEquals([box.order_date_mode, box.order_date_mode_set_at ?? null], ["asap", null]);
  assertEquals(db.tables.job_events.length, 0);
});

Deno.test("read: the toggle shows the next email's mode; sent_mode shows what was sent", async () => {
  const db = await fencingJob();
  const find = async () =>
    (await get(db, "dispatch_v2_materials", { job_id: JOB.fence })).suppliers
      .find((s: any) => s.supplier_id === SUP.stratco).date_mode;
  const box = db.tables.job_material_suppliers.find((b) => b.supplier_id === SUP.stratco)!;
  const sendIt = () => {
    const row = db.tables.dispatch_supplier_order_emails.find((e: any) =>
      e.supplier_id === SUP.stratco && e.status !== "sent"
    )!;
    row.status = "sent";
    row.sent_at = "2026-10-29T01:00:00.000Z";
    // As a real send does: the box's lines now belong to the sent order.
    for (const line of db.tables.job_material_lines) {
      if (line.supplier_id === SUP.stratco) line.dispatch_order_email_id = row.id;
    }
  };
  // Sent ASAP, then Pick a date chosen after the send.
  await makeEmail(db, JOB.fence, SUP.stratco, { delivery_date: null, date_mode: null });
  sendIt();
  let mode = await find();
  assertEquals([mode.mode, mode.sent_mode], ["asap", "asap"]);
  box.order_date_mode = "date";
  box.order_date_mode_set_at = "2026-10-29T02:00:00.000Z";
  mode = await find();
  assertEquals([mode.mode, mode.sent_mode, mode.derived], ["date", "asap", false]);
  // A choice from before the send, nothing made since: the sent mode carries on.
  box.order_date_mode_set_at = "2026-10-28T02:00:00.000Z";
  mode = await find();
  assertEquals([mode.mode, mode.sent_mode], ["asap", "asap"]);
});

Deno.test("read: sent Pick a date, then ASAP chosen after the send", async () => {
  const db = await fencingJob();
  const find = async () =>
    (await get(db, "dispatch_v2_materials", { job_id: JOB.fence })).suppliers
      .find((s: any) => s.supplier_id === SUP.stratco).date_mode;
  await makeEmail(db, JOB.fence, SUP.stratco, { date_mode: "date", delivery_date: "2026-11-04" });
  const row = db.tables.dispatch_supplier_order_emails.find((e: any) =>
    e.supplier_id === SUP.stratco
  )!;
  row.status = "sent";
  row.sent_at = "2026-10-29T01:00:00.000Z";
  for (const line of db.tables.job_material_lines) {
    if (line.supplier_id === SUP.stratco) line.dispatch_order_email_id = row.id;
  }
  const box = db.tables.job_material_suppliers.find((b) => b.supplier_id === SUP.stratco)!;
  box.order_date_mode_set_at = "2026-10-28T02:00:00.000Z"; // set before the send
  let mode = await find();
  assertEquals([mode.mode, mode.sent_mode], ["date", "date"]);
  box.order_date_mode = "asap";
  box.order_date_mode_set_at = "2026-10-29T02:00:00.000Z";
  mode = await find();
  assertEquals([mode.mode, mode.sent_mode], ["asap", "date"]);
});

Deno.test("make email: Pick a date with a date writes it and saves the choice on the box", async () => {
  const db = await fencingJob();
  const made = await makeEmail(db, JOB.fence, SUP.stratco, {
    date_mode: "date",
    delivery_date: "2026-11-04",
  });
  assert(!made.email.body_text.includes("Date: ASAP"));
  assertEquals(made.date_mode, "date");
  assertEquals(made.date_mode_saved, true);
  const box = db.tables.job_material_suppliers.find((b) => b.supplier_id === SUP.stratco)!;
  assertEquals(box.order_date_mode, "date");
  assert(box.order_date_mode_set_at);
  assertOnlyV2Writes(db);
});

Deno.test("make email: an older screen that sends only a date gets Pick a date", async () => {
  const db = await fencingJob();
  const made = await makeEmail(db, JOB.fence, SUP.stratco, {
    delivery_date: "2026-11-04",
  });
  assertEquals(made.date_mode, "date");
  assertEquals(made.email.delivery_date, "2026-11-04");
});

Deno.test("make email: ASAP with a date, or a bad choice, is refused before anything is made", async () => {
  const db = await fencingJob();
  await refused(
    makeEmail(db, JOB.fence, SUP.stratco, { date_mode: "asap", delivery_date: "2026-11-04" }),
    400,
    "invalid_request",
  );
  await refused(
    makeEmail(db, JOB.fence, SUP.stratco, { date_mode: "soon", delivery_date: null }),
    400,
    "invalid_request",
  );
  assertEquals(db.tables.dispatch_supplier_order_emails.length, 0);
});

Deno.test("read: a box made before ASAP existed reads as Pick a date when it has a date", async () => {
  const db = await fencingJob();
  const box = db.tables.job_material_suppliers.find((b) => b.supplier_id === SUP.stratco)!;
  box.order_date_mode = null;
  const before = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  const find = (read: any) => read.suppliers.find((s: any) => s.supplier_id === SUP.stratco);
  assertEquals([find(before).date_mode.mode, find(before).date_mode.derived], ["asap", true]);
  box.delivery_date = "2026-11-04";
  box.delivery_date_set_at = "2026-10-28T01:00:00.000Z";
  const after = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals([find(after).date_mode.mode, find(after).date_mode.derived], ["date", true]);
});

Deno.test("read: each box says delivery or pickup from its open email, else its newest sent one", async () => {
  const db = await fencingJob();
  const box = (read: any, id: string) =>
    read.suppliers.find((s: any) => s.supplier_id === id);
  let read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(box(read, SUP.stratco).fulfilment, null); // nothing made yet
  await makeEmail(db, JOB.fence, SUP.stratco, { fulfilment: "pickup" });
  await makeEmail(db, JOB.fence, SUP.metroll);
  read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(box(read, SUP.stratco).fulfilment, "pickup");
  assertEquals(box(read, SUP.stratco).open_email.fulfilment, "pickup");
  assertEquals(box(read, SUP.metroll).fulfilment, "delivery");
  // Once sent, the box keeps reading the sent email's opening line.
  const row = db.tables.dispatch_supplier_order_emails.find((e: any) =>
    e.supplier_id === SUP.stratco
  )!;
  row.status = "sent";
  row.sent_at = "2026-10-29T01:00:00.000Z";
  read = await get(db, "dispatch_v2_materials", { job_id: JOB.fence });
  assertEquals(box(read, SUP.stratco).open_email, null);
  assertEquals(box(read, SUP.stratco).fulfilment, "pickup");
  assertEquals(box(read, SUP.stratco).sent_emails[0].fulfilment, "pickup");
});

Deno.test("save and discard: edits are kept and seen as edited; a stale stamp is refused", async () => {
  const db = await fencingJob();
  const email = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  const saved = (await call(db, "dispatch_v2_save_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
    to: ["TradeWA@stratcowa.com.au", "second@stratcowa.com.au"],
    body_text: email.body_text.replace("Hi Team", "Hi Tony"),
  })).email;
  assertEquals(saved.to, ["tradewa@stratcowa.com.au", "second@stratcowa.com.au"]);
  assertEquals(saved.edited, true);
  await refused(
    call(db, "dispatch_v2_save_email", {
      email_id: email.id,
      expected_updated_at: email.updated_at,
      subject: "x",
    }),
    409,
    "email_changed",
  );
  await refused(
    call(db, "dispatch_v2_save_email", {
      email_id: email.id,
      expected_updated_at: saved.updated_at,
      to: ["not an email"],
    }),
    400,
    "invalid_request",
  );
  await call(db, "dispatch_v2_discard_email", {
    email_id: email.id,
    expected_updated_at: saved.updated_at,
  });
  assertEquals(db.tables.dispatch_supplier_order_emails[0].status, "discarded");
  // A discarded email does not block a new one.
  const fresh = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  assert(fresh.id !== email.id);
});

// ── Send ────────────────────────────────────────────────────────────────────

Deno.test("send: a test copy is optional, so the first real send goes without one", async () => {
  const db = await fencingJob();
  const { sent, sender } = fakeSender();
  const c = ctx(sender);
  const email = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  assertEquals(db.tables.dispatch_supplier_order_emails.some((r: any) => r.test_sent_at), false);

  const real = await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
  }, c);
  assertEquals([real.success, real.test], [true, false]);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].to, ["tradewa@stratcowa.com.au"]);
  assert(!sent[0].subject.startsWith("TEST ONLY: "));
  assertEquals(real.email.status, "sent");
});

Deno.test("send: a job held by the deposit gate sends no order; a test copy to admin@ still goes (RQ-19.e)", async () => {
  const db = await fencingJob();
  const { sent, sender } = fakeSender();
  const gateCalls: unknown[][] = [];
  const c = ctx(sender, {
    depositGate: (_client, jobId, purpose) => {
      gateCalls.push([jobId, purpose]);
      return Promise.reject(
        new JobStartDepositError("job_not_accepted", ["job_not_accepted:partially_accepted"], purpose),
      );
    },
  });
  const email = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  const test = await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
    test: true,
  }, c);
  assertEquals([test.success, test.test, sent.length, gateCalls.length], [true, true, 1, 0]);
  const err = await assertRejects(
    () =>
      call(db, "dispatch_v2_send_email", {
        email_id: email.id,
        expected_updated_at: email.updated_at,
      }, c),
    JobStartDepositError,
  );
  assertEquals([err.code, err.status], ["job_not_accepted", 409]);
  assert(err.message.startsWith("Materials cannot be ordered until every party has accepted"));
  assertEquals(gateCalls, [[JOB.fence, "materials"]]);
  assertEquals(sent.length, 1);
  assertEquals(db.tables.dispatch_supplier_order_emails[0].status, "draft");
});

Deno.test("send: test copy to admin@ only, then the real send from admin@ records the ids and locks the lines", async () => {
  const db = await fencingJob();
  await call(db, "dispatch_v2_upload_photo", {
    job_id: JOB.fence,
    supplier_id: SUP.stratco,
    data_base64: jpegBase64(),
  });
  const { sent, sender } = fakeSender();
  const c = ctx(sender);
  const email = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  assertEquals(email.photo_ids.length, 1);

  const test = await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
    test: true,
  }, c);
  assertEquals([test.success, test.test, test.sent_to, test.recorded], [
    true,
    true,
    "admin@secureworkswa.com.au",
    true,
  ]);
  assertEquals(sent[0].to, ["admin@secureworkswa.com.au"]);
  assertEquals(sent[0].cc, []);
  assert(sent[0].subject.startsWith("TEST ONLY: "));
  assert(sent[0].htmlBody.includes("tradewa@stratcowa.com.au"));
  assertEquals(sent[0].attachments.length, 1);
  // The TEST copy carries Shaun's signature too, so it shows what goes out.
  assertEquals(sent[0].signature, "shaun");
  assertEquals(test.email.status, "draft");
  assertEquals(test.email.sent, null);
  assertEquals(test.email.test.sent_to, "admin@secureworkswa.com.au");
  // The test left the stamp alone, so the same stamp sends for real.
  assertEquals(test.email.updated_at, email.updated_at);
  const row0 = db.tables.dispatch_supplier_order_emails[0];
  assertEquals(row0.sent_conversation_id ?? null, null);
  assertEquals(row0.test_conversation_id, "conv-1");

  const real = await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
  }, c);
  assertEquals([real.success, real.test, real.recorded], [true, false, true]);
  assertEquals(sent.length, 2);
  const payload = sent[1];
  assertEquals(payload.from, "admin@secureworkswa.com.au");
  assertEquals(payload.to, ["tradewa@stratcowa.com.au"]);
  assertEquals(payload.cc, [
    "tony.bacich@stratcowa.com.au",
    "fencing@secureworkswa.com.au",
  ]);
  assertEquals(payload.subject, "Material Order Ref SWF-900001");
  assertEquals(payload.signature, "shaun");
  assertEquals(payload.capture_thread_ids, true);
  assertEquals((payload as any).job_id, undefined);
  assertEquals(payload.attachments[0].contentType, "image/jpeg");
  assertEquals(payload.attachments[0].contentBytes, jpegBase64());
  assertEquals(real.email.status, "sent");
  assertEquals(real.email.sent.internet_message_id, "<order-2@secureworkswa.test>");
  assertEquals(real.email.sent.conversation_id, "conv-2");
  const row = db.tables.dispatch_supplier_order_emails[0];
  assertEquals(row.sent_graph_message_id, "graph-2");
  assertEquals(row.sent_by_email, "shaun@ops.test");
  assertEquals(row.sent_from_mailbox, "admin@secureworkswa.com.au");
  assertEquals(row.sent_to_emails, ["tradewa@stratcowa.com.au"]);
  // The two ordered lines are locked to the email; In stock and Metroll's are not.
  assertEquals(
    db.tables.job_material_lines.map((l) => [l.id, l.dispatch_order_email_id ?? null]),
    [[L(1), email.id], [L(2), email.id], [L(3), null], [L(4), null]],
  );
  await refused(
    call(db, "dispatch_v2_move_line", {
      job_id: JOB.fence,
      id: L(1),
      supplier_id: null,
      expected_updated_at: db.tables.job_material_lines[0].updated_at,
    }),
    409,
    "line_locked",
  );
  // Sending again is refused and nothing goes.
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: row.updated_at,
    }, c),
    409,
    "email_not_sendable",
  );
  assertEquals(sent.length, 2);
  // The photo that went is kept.
  await refused(
    call(db, "dispatch_v2_delete_photo", {
      job_id: JOB.fence,
      photo_id: email.photo_ids[0],
    }),
    409,
    "photo_on_email",
  );
  // Metroll's box (a non-main supplier) can still be ordered next.
  const metroll = (await makeEmail(db, JOB.fence, SUP.metroll)).email;
  const second = await call(db, "dispatch_v2_send_email", {
    email_id: metroll.id,
    expected_updated_at: metroll.updated_at,
  }, c);
  assertEquals(second.email.status, "sent");
  assertEquals(sent[2].to, ["orders@metroll.test"]);
  assert(!sent[2].htmlBody.includes("quickset"));
  assertOnlyV2Writes(db);
});

async function testedEmail(db: ReturnType<typeof makeDb>) {
  await fencingJob(db);
  const email = (await makeEmail(db, JOB.fence, SUP.stratco)).email;
  await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
    test: true,
  });
  return email;
}

Deno.test("send: changed lines, an empty Date line or a lost approval stop the send before anything goes", async () => {
  const db = makeDb();
  const email = await testedEmail(db);
  const { sent, sender } = fakeSender();
  const c = ctx(sender);
  // A line added to the box after the email was made.
  await addLine(db, JOB.fence, 5, { supplier_id: SUP.stratco, description: "Extra" });
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: email.updated_at,
    }, c),
    409,
    "order_lines_changed",
  );
  await call(db, "dispatch_v2_delete_line", {
    job_id: JOB.fence,
    id: L(5),
    expected_updated_at: db.tables.job_material_lines.find((l) => l.id === L(5))!
      .updated_at,
  });
  // The Date line emptied by an edit.
  const blanked = (await call(db, "dispatch_v2_save_email", {
    email_id: email.id,
    expected_updated_at: email.updated_at,
    body_text: email.body_text.replace("Date: 4 November 2026", "Date:"),
  })).email;
  const missing = await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: blanked.updated_at,
    }, c),
    409,
    "email_details_missing",
  );
  assertEquals(missing.body.missing, ["date"]);
  // The supplier's approved entry is retired.
  db.tables.dispatch_approved_supplier_emails[0].active = false;
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: blanked.updated_at,
    }, c),
    409,
    "no_approved_email",
  );
  assertEquals(sent.length, 0);
  // No operator email: refused before anything goes.
  db.tables.dispatch_approved_supplier_emails[0].active = true;
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: blanked.updated_at,
    }, ctx(sender, { actor: { userId: null, email: null, orgId: null } })),
    400,
    "operator_email_required",
  );
  assertEquals(sent.length, 0);
});

Deno.test("send: a refused send goes back to held; an unknown one keeps its ids and needs confirm_resend", async () => {
  const db = makeDb();
  const email = await testedEmail(db);
  const refusedSender = fakeSender(() => ({
    kind: "refused",
    reason: "Graph said no",
  }));
  const no = await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: email.updated_at,
    }, ctx(refusedSender.sender)),
    502,
    "send_refused",
  );
  assert(no.message.includes("Graph said no"));
  let row = db.tables.dispatch_supplier_order_emails[0];
  assertEquals([row.status, row.last_error], ["draft", "Graph said no"]);
  assertEquals(db.tables.job_material_lines.filter((l) => l.dispatch_order_email_id).length, 0);

  const lost = fakeSender(() => ({
    kind: "unknown",
    reason: "timeout",
    ids: {
      graph_message_id: "g-lost",
      internet_message_id: "<lost@x>",
      conversation_id: "conv-lost",
    },
  }));
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: row.updated_at,
    }, ctx(lost.sender)),
    502,
    "send_unknown",
  );
  row = db.tables.dispatch_supplier_order_emails[0];
  assertEquals(row.status, "send_unknown");
  assertEquals(row.sent_conversation_id, "conv-lost");
  assertEquals(row.sent_internet_message_id, "<lost@x>");
  // Without confirm_resend nothing goes.
  const ok = fakeSender();
  await refused(
    call(db, "dispatch_v2_send_email", {
      email_id: email.id,
      expected_updated_at: row.updated_at,
    }, ctx(ok.sender)),
    409,
    "send_unknown",
  );
  assertEquals(ok.sent.length, 0);
  // Cannot be discarded while it may have gone.
  await refused(
    call(db, "dispatch_v2_discard_email", {
      email_id: email.id,
      expected_updated_at: row.updated_at,
    }),
    409,
    "email_not_discardable",
  );
  const resent = await call(db, "dispatch_v2_send_email", {
    email_id: email.id,
    expected_updated_at: row.updated_at,
    confirm_resend: true,
  }, ctx(ok.sender));
  assertEquals(resent.email.status, "sent");
  assertEquals(ok.sent.length, 1);
  assertEquals(resent.email.sent.conversation_id, "conv-1");
});

Deno.test("send: a send claimed long ago with no answer reads as unknown", () => {
  const view = projectDispatchV2Email({
    id: "e",
    status: "sending",
    send_claimed_at: "2026-10-23T01:00:00Z",
    body_text: "x",
    built_body_text: "x",
  }, Date.parse("2026-10-23T01:05:00Z"));
  assertEquals(view.status, "send_unknown");
  const fresh = projectDispatchV2Email({
    id: "e",
    status: "sending",
    send_claimed_at: "2026-10-23T01:04:30Z",
    body_text: "x",
    built_body_text: "x",
  }, Date.parse("2026-10-23T01:05:00Z"));
  assertEquals(fresh.status, "sending");
});

// ── The gate ────────────────────────────────────────────────────────────────

Deno.test("gate: the seventeen actions are staff only and on no allow-list", () => {
  assertEquals(DISPATCH_V2_ACTIONS.length, 18);
  assertEquals(DISPATCH_V2_READ_ACTIONS.length, 3);
  assertEquals(DISPATCH_V2_WRITE_ACTIONS.length, 15);
  for (const action of DISPATCH_V2_ACTIONS) {
    const url = new URL(
      `https://example.test/functions/v1/ops-api?action=${action}`,
    );
    for (const role of ["admin", "owner", "ops_manager"]) {
      assertEquals(
        _authorizeOpsApiAction({ url, authMode: "jwt", authUser: { role } }),
        { ok: true },
      );
    }
    for (
      const authUser of [{ role: "installer" }, {
        role: "lead_installer",
        managedVerticals: ["fencing", "patio"],
      }]
    ) {
      const refusedCall = _authorizeOpsApiAction({
        url,
        authMode: "jwt",
        authUser,
      }) as any;
      assertEquals([refusedCall.ok, refusedCall.status, refusedCall.code], [
        false,
        403,
        "operator_access_required",
      ], `${action} ${authUser.role}`);
    }
    assert(!AGENT_READ_ALLOWED_ACTIONS.has(action));
    assert(!LEAD_INSTALLER_READ_ACTIONS.has(action));
  }
});

const ENV: Record<string, string> = {
  ...IMPORT_ENV,
  MAKESAFE_ROUTINE_KEY: ROUTINE_KEY,
};

async function withEnvAndFetchSpy<T>(
  fn: (calls: string[]) => Promise<T>,
): Promise<T> {
  const saved = new Map(Object.keys(ENV).map((n) => [n, Deno.env.get(n)]));
  for (const [n, v] of Object.entries(ENV)) Deno.env.set(n, v);
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: Request | URL | string) => {
    calls.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(new Response("{}", { status: 500 }));
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
    for (const [n, v] of saved) {
      if (v === undefined) Deno.env.delete(n);
      else Deno.env.set(n, v);
    }
  }
}

Deno.test("gate: the routine key is refused on all seventeen before any call; a write by GET is 405", async () => {
  await withEnvAndFetchSpy(async (calls) => {
    for (const action of DISPATCH_V2_ACTIONS) {
      const isRead = (DISPATCH_V2_READ_ACTIONS as readonly string[]).includes(
        action,
      );
      const res = await _opsApiRequestHandlerForTest(
        new Request(
          `https://example.invalid/ops-api?action=${action}&job_id=${JOB.fence}`,
          {
            method: isRead ? "GET" : "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": ROUTINE_KEY,
            },
            body: isRead ? undefined : JSON.stringify({ job_id: JOB.fence }),
          },
        ),
      );
      assertEquals(res.status, 403, action);
      await res.body?.cancel();
    }
    for (const action of DISPATCH_V2_WRITE_ACTIONS) {
      const res = await _opsApiRequestHandlerForTest(
        new Request(`https://example.invalid/ops-api?action=${action}`, {
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SERVICE_KEY}`,
          },
        }),
      );
      assertEquals(res.status, 405, action);
      await res.body?.cancel();
    }
    // The privileged key reaches the action; a bad id is a 400 before any read.
    const bad = await _opsApiRequestHandlerForTest(
      new Request(
        "https://example.invalid/ops-api?action=dispatch_v2_send_email",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SERVICE_KEY}`,
          },
          body: JSON.stringify({ email_id: "nope", operator_email: "shaun@ops.test" }),
        },
      ),
    );
    assertEquals(bad.status, 400);
    await bad.body?.cancel();
    assertEquals(calls, []);
  });
});

// ── Ruling 17 step 3: lines carry their cost from the job budget ────────────

const BUDGET = uuid("ab", 1);

// A patio job's stored budget (job_budgets, budget.v1), sealed with the job's
// frozen revision: two costed lines, one with no cost yet, Stratco's
// delivery, and screws that never go on supplier copy.
function patioBudget() {
  return {
    version: "budget.v1",
    materials: {
      priced_by_line: true,
      total_ex_gst: 725,
      lines: [
        { key: "b-roof", line_id: "SL-roof", supplier_key: "stratco", supplier: { id: "stratco", name: "Stratco" }, kind: "item", description: "Trimdek roof sheet 4,600", quantity: 10, unit: "sheet", unit_cost_ex_gst: 45.5, line_cost_ex_gst: 455, in_total: true, cost_from: "supplier_price", note_to_supplier: "Cut to 4,600" },
        { key: "b-post", line_id: "SL-post", supplier_key: "metroll", supplier: { id: "metroll", name: "Metroll" }, kind: "item", description: "100x100 SHS post 2,900", quantity: 3, unit: "length", unit_cost_ex_gst: 60, line_cost_ex_gst: 180, in_total: true, cost_from: "supplier_price", note_to_supplier: null },
        { key: "b-flash", line_id: "SL-flash", supplier_key: "stratco", supplier: { id: "stratco", name: "Stratco" }, kind: "item", description: "Barge flashing 3,000", quantity: 4, unit: "length", unit_cost_ex_gst: null, line_cost_ex_gst: null, in_total: false, cost_from: "not_bought_before", note_to_supplier: null },
        { key: "stratco:delivery", line_id: null, supplier_key: "stratco", supplier: { id: "stratco", name: "Stratco" }, kind: "delivery", description: "Delivery", quantity: 1, unit: "each", unit_cost_ex_gst: 90, line_cost_ex_gst: 90, in_total: true, cost_from: "supplier_price", note_to_supplier: null },
        { key: "b-tek", line_id: "SL-fix", supplier_key: "stratco", supplier: { id: "stratco", name: "Stratco" }, kind: "item", description: "Tek screws 14g x 22", quantity: 200, unit: "each", unit_cost_ex_gst: 0.1, line_cost_ex_gst: 20, in_total: true, cost_from: "supplier_price", note_to_supplier: null },
      ],
      by_supplier: [
        { key: "stratco", supplier: { id: "stratco", name: "Stratco" }, lines_ex_gst: 475, surcharge_ex_gst: 0, delivery_ex_gst: 90, total_ex_gst: 565 },
        { key: "metroll", supplier: { id: "metroll", name: "Metroll" }, lines_ex_gst: 180, surcharge_ex_gst: 0, delivery_ex_gst: 0, total_ex_gst: 180 },
      ],
    },
  };
}

async function budgetJob(on = true, db = makeDb()) {
  db.tables.jobs.find((j: any) => j.id === JOB.patio)!.scope_json = patioRecord();
  const revision = await seal(db, JOB.patio, 3);
  db.tables.job_budgets.push({ id: BUDGET, job_id: JOB.patio, scope_revision_id: revision, version: 1, trade: "patio", budget: patioBudget() });
  if (on) db.tables.feature_flags.push({ flag_name: "dispatch_budget_cost_v1", enabled: true });
  return { db, revision };
}

const lineByKey = (db: ReturnType<typeof makeDb>, key: string) =>
  db.tables.job_material_lines.find((l: any) => l.budget_line_key === key)!;

Deno.test("budget cost off: a job with a stored budget fills, makes and reads exactly as before", async () => {
  const { db } = await budgetJob(false);
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  assertEquals(out.lines.length, 7, "the sealed scope lines, as before");
  assert(db.tables.job_material_lines.every((l: any) => !("budget_id" in l) && !("budget_line_key" in l)));
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.patio });
  assertEquals(read.budget, null);
  assert(read.suppliers.every((b: any) => b.lines.every((l: any) => !("cost" in l))));
  const made = await makeEmail(db, JOB.patio, SUP.stratco);
  assertEquals(made.email.order_cost, null);
  assert(db.tables.dispatch_supplier_order_emails.every((e: any) => !("order_cost" in e)));
  assertEquals(db.tables.dispatch_line_cost_reasons, []);
});

Deno.test("budget fill: the budget's materials are the order, each line naming its budget line, its note on the line", async () => {
  const { db, revision } = await budgetJob();
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  assertEquals(
    out.lines.map((l: any) => [l.description, l.quantity, l.unit, l.supplier_id, l.scope_line_id, l.budget_line_key, l.detail]),
    [
      ["Trimdek roof sheet 4,600", 10, "sheet", SUP.stratco, "SL-roof", "b-roof", "Cut to 4,600"],
      ["100x100 SHS post 2,900", 3, "length", SUP.metroll, "SL-post", "b-post", null],
      ["Barge flashing 3,000", 4, "length", SUP.stratco, "SL-flash", "b-flash", null],
    ],
  );
  assert(db.tables.job_material_lines.every((l: any) => l.budget_id === BUDGET && l.source_version_id === revision));
  assert(out.notes.some((n: string) => n.includes("Delivery and cutting charges stay on the budget")));
  assert(out.notes.some((n: string) => n.includes("Tek screws 14g x 22")));
  assertOnlyV2Writes(db);
});

Deno.test("budget fill: a budget sealed with another revision is refused, nothing filled", async () => {
  const { db } = await budgetJob();
  db.tables.job_budgets[0].scope_revision_id = uuid("f1", 99);
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio }), 409, "budget_not_current_revision");
  assertEquals(db.tables.job_material_lines, []);
});

Deno.test("budget read: each line carries its cost, and the budget block counts the lines still needing a reason", async () => {
  const { db } = await budgetJob();
  await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.patio });
  assertEquals([read.budget.state, read.budget.budget_id, read.budget.lines_needing_reason], ["ok", BUDGET, 1]);
  const stratco = read.suppliers.find((b: any) => b.supplier_id === SUP.stratco);
  assertEquals(
    stratco.lines.map((l: any) => [l.budget_line_key, l.cost.basis, l.cost.line_cost_ex_gst, l.cost.resolved]),
    [["b-roof", "budget", 455, true], ["b-flash", "no_budget_cost", null, false]],
  );
});

Deno.test("budget make: a line with no budget cost holds the order until a signed-in person gives a reason and a unit cost", async () => {
  const { db } = await budgetJob();
  await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  await refused(makeEmail(db, JOB.patio, SUP.stratco), 409, "line_cost_needs_reason");
  assertEquals(db.tables.dispatch_supplier_order_emails, []);
  const flash = lineByKey(db, "b-flash");
  const ask = { job_id: JOB.patio, line_id: flash.id, expected_updated_at: flash.updated_at, reason: "Builder asked for barge flashing" };
  // The ops key names nobody.
  await refused(call(db, "dispatch_v2_line_cost_reason", ask, ctx(undefined, { actor: { userId: null, email: "ops@ops.test", orgId: null } as any })), 403, "named_person_required");
  await refused(call(db, "dispatch_v2_line_cost_reason", ask), 400, "unit_cost_required");
  await refused(call(db, "dispatch_v2_line_cost_reason", { ...ask, reason: "ok" }), 400, "invalid_request");
  const given = await call(db, "dispatch_v2_line_cost_reason", { ...ask, unit_cost_ex_gst: 12.5 });
  assertEquals([given.line.cost.basis, given.line.cost.unit_cost_ex_gst, given.line.cost.line_cost_ex_gst, given.line.cost.resolved], ["no_budget_cost", 12.5, 50, true]);
  assertEquals(db.tables.dispatch_line_cost_reasons.map((r: any) => [r.basis, r.quantity, r.unit, r.unit_cost_ex_gst, r.given_by, r.budget_line_key]), [
    ["no_budget_cost", 4, "length", 12.5, SHAUN.userId, "b-flash"],
  ]);
  const made = await makeEmail(db, JOB.patio, SUP.stratco);
  const oc = made.email.order_cost;
  assertEquals([oc.version, oc.budget_id, oc.lines_ex_gst], ["dispatch-order-cost.v1", BUDGET, 505]);
  assertEquals(oc.lines.map((l: any) => [l.budget_line_key, l.basis, l.line_cost_ex_gst, l.reason_id !== null]), [
    ["b-roof", "budget", 455, false],
    ["b-flash", "no_budget_cost", 50, true],
  ]);
  assertEquals(oc.supplier_budget.total_ex_gst, 565);
  // The supplier's email prints no dollar.
  const body = made.email.body_text as string;
  assert(!/\$|45\.5|455|12\.5/.test(body), body);
  assert(body.includes("Trimdek roof sheet 4,600") && body.includes("Cut to 4,600"));
  const sent = await call(db, "dispatch_v2_send_email", { email_id: made.email.id, expected_updated_at: made.email.updated_at });
  assertEquals(sent.email.status, "sent");
  assertOnlyV2Writes(db);
});

Deno.test("budget make: over its budget line needs a reason for that quantity; a later rise needs another", async () => {
  const { db } = await budgetJob();
  await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  let post = lineByKey(db, "b-post");
  const raised = await call(db, "dispatch_v2_save_line", {
    job_id: JOB.patio,
    expected_updated_at: post.updated_at,
    line: { id: post.id, description: post.description, quantity: 4, unit: post.unit },
  });
  await refused(makeEmail(db, JOB.patio, SUP.metroll), 409, "line_cost_needs_reason");
  // The budget has a unit cost for this line, so none is taken.
  const ask = { job_id: JOB.patio, line_id: post.id, expected_updated_at: raised.line.updated_at, reason: "One extra post for the corner" };
  await refused(call(db, "dispatch_v2_line_cost_reason", { ...ask, unit_cost_ex_gst: 70 }), 400, "invalid_request");
  const given = await call(db, "dispatch_v2_line_cost_reason", ask);
  assertEquals([given.line.cost.basis, given.line.cost.line_cost_ex_gst, given.line.cost.resolved], ["over_budget", 240, true]);
  // A stale stamp gives no reason.
  await refused(call(db, "dispatch_v2_line_cost_reason", ask), 409, "line_changed");
  post = lineByKey(db, "b-post");
  const again = await call(db, "dispatch_v2_save_line", {
    job_id: JOB.patio,
    expected_updated_at: post.updated_at,
    line: { id: post.id, description: post.description, quantity: 5, unit: post.unit },
  });
  assertEquals(again.line.cost_reason_id, given.line.cost_reason_id);
  await refused(makeEmail(db, JOB.patio, SUP.metroll), 409, "line_cost_needs_reason");
  // A line within its budget needs none.
  const roof = lineByKey(db, "b-roof");
  await refused(call(db, "dispatch_v2_line_cost_reason", { job_id: JOB.patio, line_id: roof.id, expected_updated_at: roof.updated_at, reason: "No need at all" }), 409, "line_within_budget");
});

Deno.test("budget make: a line typed in is not in the budget and needs a reason and a unit cost", async () => {
  const { db } = await budgetJob();
  await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  await addBox(db, JOB.patio, SUP.metroll).catch(() => null);
  const typed = await addLine(db, JOB.patio, 40, { supplier_id: SUP.metroll, description: "Extra bracket", quantity: 2, unit: "each" });
  await refused(makeEmail(db, JOB.patio, SUP.metroll), 409, "line_cost_needs_reason");
  const given = await call(db, "dispatch_v2_line_cost_reason", {
    job_id: JOB.patio, line_id: typed.id, expected_updated_at: typed.updated_at, reason: "Site needs a bracket", unit_cost_ex_gst: 9,
  });
  assertEquals([given.line.cost.basis, given.line.cost.line_cost_ex_gst], ["not_in_budget", 18]);
  const made = await makeEmail(db, JOB.patio, SUP.metroll);
  assertEquals(made.email.order_cost.lines_ex_gst, 198);
});

Deno.test("budget send: an email made before its lines were costed is refused; made again, it goes", async () => {
  const { db } = await budgetJob(false);
  await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  const made = await makeEmail(db, JOB.patio, SUP.metroll);
  db.tables.feature_flags.push({ flag_name: "dispatch_budget_cost_v1", enabled: true });
  await refused(call(db, "dispatch_v2_send_email", { email_id: made.email.id, expected_updated_at: made.email.updated_at }), 409, "order_cost_missing");
  assertEquals(db.tables.dispatch_supplier_order_emails[0].status, "draft");
});

Deno.test("budget: an unreadable budget refuses the make press and the fill; the read says so", async () => {
  const { db } = await budgetJob();
  await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  db.failures.add("select:job_budgets");
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.patio });
  assertEquals(read.budget, { state: "unreadable" });
  await refused(makeEmail(db, JOB.patio, SUP.metroll), 503, "budget_unreadable");
  assertEquals(db.tables.dispatch_supplier_order_emails, []);
});

Deno.test("budget switch unreadable: the fill, the make press, the send and a reason refuse (retryable) and change nothing; the read says so", async () => {
  const { db } = await budgetJob();
  await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  // Made while the switch read fine: every Metroll line is within its budget.
  const made = await makeEmail(db, JOB.patio, SUP.metroll);
  assertEquals(made.email.order_cost.budget_id, BUDGET);
  db.failures.add("select:feature_flags");
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.patio });
  assertEquals(read.budget, { state: "switch_unreadable" });
  const before = db.writes().length;
  await refused(makeEmail(db, JOB.patio, SUP.stratco), 503, "budget_switch_unreadable");
  const { sent, sender } = fakeSender();
  await refused(call(db, "dispatch_v2_send_email", { email_id: made.email.id, expected_updated_at: made.email.updated_at }, ctx(sender)), 503, "budget_switch_unreadable");
  assertEquals(sent, []);
  const flash = lineByKey(db, "b-flash");
  await refused(call(db, "dispatch_v2_line_cost_reason", { job_id: JOB.patio, line_id: flash.id, expected_updated_at: flash.updated_at, reason: "Builder asked for barge flashing", unit_cost_ex_gst: 12.5 }), 503, "budget_switch_unreadable");
  assertEquals(db.writes().length, before);
  assertEquals(db.tables.dispatch_line_cost_reasons, []);
  assertEquals(db.tables.dispatch_supplier_order_emails.map((e: any) => e.status), ["draft"]);
  assertEquals(db.tables.feature_flags[0].enabled, true);
});

Deno.test("budget switch unreadable: a fill refuses before writing a line", async () => {
  const { db } = await budgetJob();
  db.failures.add("select:feature_flags");
  await refused(call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio }), 503, "budget_switch_unreadable");
  assertEquals(db.tables.job_material_lines, []);
});

Deno.test("budget switch explicitly off reads exactly as a missing switch: the old path", async () => {
  const { db } = await budgetJob(false);
  db.tables.feature_flags.push({ flag_name: "dispatch_budget_cost_v1", enabled: false });
  const out = await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  assertEquals(out.lines.length, 7, "the sealed scope lines, as before");
  const read = await get(db, "dispatch_v2_materials", { job_id: JOB.patio });
  assertEquals(read.budget, null);
  const made = await makeEmail(db, JOB.patio, SUP.stratco);
  assertEquals(made.email.order_cost, null);
});

Deno.test("budget make: a line's stock length, cuts and colour from the sealed budget print on the supplier email, never a dollar", async () => {
  const { db } = await budgetJob();
  const post = db.tables.job_budgets[0].budget.materials.lines.find((l: any) => l.key === "b-post");
  Object.assign(post, { stock_length_mm: 6500, cuts: [{ length_mm: 2900, qty: 3 }], stock_to_confirm: false, profile: null, colour: "Monument", cut: "3 × 2900" });
  await call(db, "dispatch_v2_suggest_draft", { job_id: JOB.patio });
  const line = lineByKey(db, "b-post");
  assertEquals([line.detail, line.colour], ["Length: 6,500 mm\nCuts: 3 x 2,900 mm", "Monument"]);
  const made = await makeEmail(db, JOB.patio, SUP.metroll);
  const body = made.email.body_text as string;
  assert(body.includes("3 length x 100x100 SHS post 2,900\nLength: 6,500 mm\nCuts: 3 x 2,900 mm\nColour: Monument"), body);
  assert(!/\$|\b60\b|180/.test(body), body);
});
