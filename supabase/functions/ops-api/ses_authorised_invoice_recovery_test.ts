// deno-lint-ignore-file no-import-prefix no-explicit-any
/**
 * Authorised-invoice PDF recovery seam.
 *
 * When the obligation is already AUTHORISED and a later docket re-prepare left
 * the current pre_xero docket without the Xero PDF bind, recovery rebinds the
 * exact same invoice without a second human APPROVE. Never mints, re-authorises,
 * voids, or sends.
 *
 * Adopt-on-unique-constraint: an earlier bind may already occupy
 * (job_id, ses-invoice-bound:{obligation}, assembler, family). Replay must
 * adopt that row when identity matches, not refuse with 23505.
 *
 * ## What these tests prove and do not prove
 *
 * They exercise the REAL unique-index shape declared by the migration
 * (job_id, idempotency_key, assembler_version, family_matrix_version) via an
 * in-process table that raises Postgres-shaped 23505 with the live truncated
 * constraint name. That is the path the prior suite never hit: the old mock
 * only short-circuited on content-addressed id equality and never raised the
 * obligation-key collision that failed Bertram in production.
 *
 * They do NOT prove:
 * - live PostgREST transport or error envelope encoding
 * - the SQL function body of commit_ses_invoice_bound_docket_v1
 * - concurrent advisory-lock races under real Postgres
 * The ops-api harness has no Postgres; a green run here is not a green
 * production bind. See data/learnings.md (mock-DB gap).
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adoptExistingInvoiceBoundDocket,
  bindAuthorisedInvoicePdfToDocket,
  boundInvoiceIdentityDiffs,
  executeSesInvoiceRevisionAction,
  isMakesafeDocketRevisionUniqueConstraintError,
  MAKESAFE_DOCKET_REVISION_IDEMPOTENCY_CONSTRAINT,
  recoverAuthorisedInvoicePdfBind,
  SesActionError,
  sesInvoiceBoundIdempotencyKey,
  type SesXeroGateway,
} from "./ses_reporting_actions.ts";
import { sesSha256, stableUuidFromSha256 } from "./ses_docket_envelope.ts";

const ORG_ID = "00000000-0000-4000-8000-000000000099";
const JOB_ID = "208450c0-7161-4b30-9514-66226b054609";
const OBLIGATION_ID = "68e5432f-0000-4000-8000-000000000001";
const PRE_XERO_DOCKET_ID = "6a55da20-0000-4000-8000-000000000002";
const PRIOR_PRE_XERO_ID = "b02d63f0-0000-4000-8000-000000000003";
const PRIOR_BOUND_ID = "5f39d8d1-0000-4000-8000-000000000004";
const XERO_ID = "xero-inv-1102";
const INVOICE_NUMBER = "INV-1102";
const TOTAL = 825;
const ASSEMBLER = "ses-pack-assembler/v1";
const FAMILY = "ses-builder-family-matrix/2026-07-30.6";
const PDF_HASH =
  "sha256:0f17f8f772efceda6d19ae2eda2a43e7646f77f9abb5b9bdc18953e4c5797d10";

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

function authorisedInvoice(overrides: Record<string, unknown> = {}) {
  return {
    xero_invoice_id: XERO_ID,
    invoice_number: INVOICE_NUMBER,
    status: "AUTHORISED",
    reference: "AJBR-70271",
    total: TOTAL,
    ...overrides,
  };
}

function preXeroDocket(overrides: Record<string, unknown> = {}) {
  return {
    id: PRE_XERO_DOCKET_ID,
    job_id: JOB_ID,
    stage: "pre_xero",
    invoice_obligation_revision_id: OBLIGATION_ID,
    attendance_cycle_ids: ["cycle-1"],
    assembler_version: ASSEMBLER,
    family_matrix_version: FAMILY,
    envelope: { v2: { classification: {}, items: {} } },
    email_drafts: {},
    local_invoice_proposal: { builder_reference: "AJBR-70271" },
    committed_at: "2026-08-04T09:08:28Z",
    ...overrides,
  };
}

function priorBoundDocket(overrides: Record<string, unknown> = {}) {
  return {
    id: PRIOR_BOUND_ID,
    job_id: JOB_ID,
    stage: "invoice_bound",
    idempotency_key: sesInvoiceBoundIdempotencyKey(OBLIGATION_ID),
    assembler_version: ASSEMBLER,
    family_matrix_version: FAMILY,
    invoice_obligation_revision_id: OBLIGATION_ID,
    based_on_revision_id: PRIOR_PRE_XERO_ID,
    output_content_hash: "sha256:" + "a".repeat(64),
    xero_binding: {
      xero_invoice_id: XERO_ID,
      invoice_number: INVOICE_NUMBER,
      status: "AUTHORISED",
      total: TOTAL,
      // Live Bertram had null here; PDF lives on the artifact row.
      pdf_content_hash: null,
    },
    pre_xero_docs_ready: true,
    envelope: { v2: { classification: {}, items: {} } },
    email_drafts: {},
    attendance_cycle_ids: ["cycle-1"],
    committed_at: "2026-08-04T09:05:21Z",
    ...overrides,
  };
}

/**
 * In-process unique index matching the migration:
 * UNIQUE (job_id, idempotency_key, assembler_version, family_matrix_version).
 * Second insert with a different id under the same key raises 23505 with the
 * live truncated constraint name — not a hand-waved mock return.
 */
function uniqueKey(row: {
  job_id: string;
  idempotency_key: string;
  assembler_version: string;
  family_matrix_version: string;
}): string {
  return [
    row.job_id,
    row.idempotency_key,
    row.assembler_version,
    row.family_matrix_version,
  ].join("\0");
}

function recoveryClient(opts: {
  revision: Record<string, any>;
  currentDocket: Record<string, any>;
  /** Extra docket rows (e.g. prior invoice_bound) held in the unique index. */
  docketRows?: Array<Record<string, any>>;
  artifacts?: Array<Record<string, any>>;
  commitReturns?: Record<string, any> | null;
  track?: { commits: number; uploads: number; authorises: number; creates: number };
  /** When true, commit emulates the real unique index (default true). */
  enforceUnique?: boolean;
}) {
  const track = opts.track || {
    commits: 0,
    uploads: 0,
    authorises: 0,
    creates: 0,
  };
  const enforceUnique = opts.enforceUnique !== false;
  const artifacts = [...(opts.artifacts || [])];
  const docketById = new Map<string, Record<string, any>>();
  const uniqueIndex = new Map<string, string>(); // key → id
  /** Test hook: plant a row into the unique index without SELECT visibility until flushed. */
  const pendingIndexOnly: Array<Record<string, any>> = [];

  function indexRow(row: Record<string, any>) {
    docketById.set(String(row.id), row);
    if (
      row.job_id && row.idempotency_key && row.assembler_version &&
      row.family_matrix_version
    ) {
      uniqueIndex.set(uniqueKey(row as any), String(row.id));
    }
  }

  // Base pre_xero and any seed rows.
  indexRow(opts.currentDocket);
  if (
    opts.currentDocket.based_on_revision_id &&
    !docketById.has(String(opts.currentDocket.based_on_revision_id))
  ) {
    // no-op: base may be the current itself for pre_xero
  }
  for (const row of opts.docketRows || []) indexRow(row);
  // Always index a synthetic base for prior bound based_on when present.
  if (!docketById.has(PRIOR_PRE_XERO_ID)) {
    indexRow({
      id: PRIOR_PRE_XERO_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      assembler_version: ASSEMBLER,
      family_matrix_version: FAMILY,
      idempotency_key: "prior-pre-xero",
    });
  }
  // Ensure current pre_xero is findable by id for based_on loads.
  if (opts.currentDocket.stage === "pre_xero") {
    indexRow(opts.currentDocket);
  }

  let committedDocket = opts.commitReturns ?? null;
  if (committedDocket) indexRow(committedDocket);

  type Filter = { col: string; op: "eq" | "in"; value: unknown };
  function matches(row: Record<string, any>, filters: Filter[]): boolean {
    return filters.every((f) => {
      if (f.op === "eq") return String(row[f.col] ?? "") === String(f.value ?? "");
      if (f.op === "in") {
        const list = Array.isArray(f.value) ? f.value : [];
        return list.map(String).includes(String(row[f.col] ?? ""));
      }
      return true;
    });
  }

  function queryTable(table: string) {
    const filters: Filter[] = [];
    let orderCol: string | null = null;
    let orderAsc = true;
    let limitN: number | null = null;

    const builder: any = {
      select: () => builder,
      eq: (col: string, value: unknown) => {
        filters.push({ col, op: "eq", value });
        return builder;
      },
      in: (col: string, value: unknown) => {
        filters.push({ col, op: "in", value });
        return builder;
      },
      not: () => builder,
      or: () => builder,
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderCol = col;
        orderAsc = opts?.ascending !== false;
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      update: () => builder,
      upsert: () => builder,
      maybeSingle: async () => {
        const rows = collect();
        return { data: rows[0] ?? null, error: null };
      },
      single: async () => {
        const rows = collect();
        return { data: rows[0] ?? null, error: null };
      },
      then: (resolve: any, reject: any) => {
        return Promise.resolve({ data: collect(), error: null }).then(
          resolve,
          reject,
        );
      },
    };

    function collect(): any[] {
      if (table === "makesafe_invoice_obligation_revisions") {
        return matches(opts.revision, filters) ? [opts.revision] : [];
      }
      if (table === "makesafe_docket_revisions_current") {
        // Newest by committed_at among all dockets for the job.
        const all = [...docketById.values()].filter((r) =>
          matches(r, filters)
        );
        all.sort((a, b) =>
          String(b.committed_at || "").localeCompare(String(a.committed_at || ""))
        );
        // Prefer explicit current if still newest; after commit, bound may win.
        if (committedDocket && committedDocket.stage === "invoice_bound") {
          const boundMatches = matches(committedDocket, filters);
          if (boundMatches && (!all[0] || all[0].id === committedDocket.id)) {
            return [committedDocket];
          }
        }
        // View: highest committed_at. Seed current as newest pre_xero unless
        // a newer row exists.
        const byJob = [...docketById.values()]
          .filter((r) => String(r.job_id) === JOB_ID)
          .filter((r) => filters.every((f) => {
            if (f.col === "job_id") return String(r.job_id) === String(f.value);
            if (f.col === "id") return String(r.id) === String(f.value);
            return matches(r, [f]);
          }));
        byJob.sort((a, b) =>
          String(b.committed_at || "").localeCompare(
            String(a.committed_at || ""),
          )
        );
        return byJob[0] ? [byJob[0]] : [];
      }
      if (table === "makesafe_docket_revisions") {
        let rows = [...docketById.values()].filter((r) => matches(r, filters));
        if (orderCol) {
          rows = rows.slice().sort((a, b) => {
            const av = String(a[orderCol!] ?? "");
            const bv = String(b[orderCol!] ?? "");
            return orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (limitN != null) rows = rows.slice(0, limitN);
        return rows;
      }
      if (table === "makesafe_readiness_current_v2") {
        return [{
          readiness_revision: "ready-1",
          dependency_generation: 1,
          ready: true,
        }];
      }
      if (table === "makesafe_docket_artifacts") {
        let rows = artifacts.filter((a) => {
          // Attach revision_id filter via eq on builder — artifacts may carry it.
          return matches(a, filters);
        });
        // If filters include revision_id and role, and bound has PDF seeded:
        if (rows.length === 0 && committedDocket?.stage === "invoice_bound") {
          const revFilter = filters.find((f) => f.col === "revision_id");
          const roleFilter = filters.find((f) => f.col === "role");
          if (
            revFilter && String(revFilter.value) === String(committedDocket.id) &&
            (!roleFilter || roleFilter.value === "xero_invoice_pdf")
          ) {
            return [{
              revision_id: committedDocket.id,
              role: "xero_invoice_pdf",
              content_hash: committedDocket.xero_binding?.pdf_content_hash ||
                PDF_HASH,
              metadata: {
                xero_invoice_id: XERO_ID,
                invoice_number: INVOICE_NUMBER,
              },
            }];
          }
        }
        return rows;
      }
      if (
        table === "job_assignments" || table === "job_service_reports" ||
        table === "xero_invoices"
      ) {
        return [];
      }
      return [];
    }

    return builder;
  }

  return {
    track,
    docketById,
    uniqueIndex,
    artifacts,
    /** Index-only plant: visible to unique check, not to SELECT until reveal. */
    plantUniqueOccupant(row: Record<string, any>, pdfArtifact?: Record<string, any>) {
      uniqueIndex.set(uniqueKey(row as any), String(row.id));
      pendingIndexOnly.push(row);
      if (pdfArtifact) artifacts.push(pdfArtifact);
    },
    revealPendingOccupants() {
      for (const row of pendingIndexOnly) indexRow(row);
      pendingIndexOnly.length = 0;
    },
    from(table: string) {
      return queryTable(table);
    },
    async rpc(name: string, args: Record<string, any>) {
      if (name === "commit_ses_invoice_bound_docket_v1") {
        track.commits += 1;
        const binding = args.p_binding || {};
        const pdf = args.p_pdf_artifact || {};
        const id = String(binding.id);
        const jobId = String(binding.job_id);
        const baseId = String(binding.based_on_revision_id);
        const base = docketById.get(baseId);
        if (!base || base.stage !== "pre_xero") {
          return {
            data: null,
            error: {
              code: "23514",
              message: "invoice PDF must bind from a pre-Xero docket revision",
            },
          };
        }
        // SQL same-id return path.
        const existingById = docketById.get(id);
        if (
          existingById &&
          existingById.stage === "invoice_bound" &&
          existingById.invoice_obligation_revision_id ===
            binding.invoice_obligation_revision_id &&
          object(existingById.xero_binding).xero_invoice_id ===
            object(binding.xero_binding).xero_invoice_id
        ) {
          return { data: existingById, error: null };
        }
        const row = {
          id,
          job_id: jobId,
          stage: "invoice_bound",
          idempotency_key: sesInvoiceBoundIdempotencyKey(
            binding.invoice_obligation_revision_id,
          ),
          assembler_version: base.assembler_version,
          family_matrix_version: base.family_matrix_version,
          invoice_obligation_revision_id: binding.invoice_obligation_revision_id,
          based_on_revision_id: binding.based_on_revision_id,
          output_content_hash: binding.output_content_hash,
          xero_binding: binding.xero_binding,
          pre_xero_docs_ready: true,
          envelope: { v2: { classification: {}, items: {} } },
          email_drafts: {},
          attendance_cycle_ids: base.attendance_cycle_ids || [],
          committed_at: new Date().toISOString(),
        };
        if (enforceUnique) {
          const key = uniqueKey(row);
          const occupant = uniqueIndex.get(key);
          if (occupant && occupant !== id) {
            // After the collision, the row is readable for adopt (Postgres
            // visibility: the winning transaction already committed).
            for (const pending of pendingIndexOnly) indexRow(pending);
            pendingIndexOnly.length = 0;
            return {
              data: null,
              error: {
                code: "23505",
                message:
                  `duplicate key value violates unique constraint "${MAKESAFE_DOCKET_REVISION_IDEMPOTENCY_CONSTRAINT}"`,
                details:
                  `Key (job_id, idempotency_key, assembler_version, family_matrix_version)=(${jobId}, ${row.idempotency_key}, ${row.assembler_version}, ${row.family_matrix_version}) already exists.`,
              },
            };
          }
        }
        indexRow(row);
        committedDocket = row;
        artifacts.push({
          revision_id: id,
          role: "xero_invoice_pdf",
          content_hash: pdf.content_hash,
          metadata: pdf.metadata || {
            xero_invoice_id: XERO_ID,
            invoice_number: INVOICE_NUMBER,
          },
        });
        return { data: row, error: null };
      }
      if (name === "record_ses_docket_review_state_v1") {
        return { data: { recorded: true }, error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    },
    storage: {
      from: () => ({
        upload: async () => {
          track.uploads += 1;
          if (track.uploads > 1) {
            return {
              data: null,
              error: { message: "The resource already exists" },
            };
          }
          return { data: { path: "ok" }, error: null };
        },
        download: async () => ({ data: null, error: { message: "unused" } }),
        createSignedUrl: async () =>
          ({ data: null, error: { message: "unused" } }),
      }),
    },
  };
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function gateway(opts: {
  live?: Record<string, any> | null | Array<Record<string, any>>;
  track?: { authorises: number; creates: number; pdfFetches: number };
}): SesXeroGateway {
  const track = opts.track || { authorises: 0, creates: 0, pdfFetches: 0 };
  const live = opts.live === undefined
    ? [authorisedInvoice()]
    : Array.isArray(opts.live)
    ? opts.live
    : opts.live
    ? [opts.live]
    : [];
  return {
    async createDraft() {
      track.creates += 1;
      throw new Error("recovery must never mint a second invoice");
    },
    async reconcileCreate() {
      return [];
    },
    async authorise() {
      track.authorises += 1;
      throw new Error("recovery must never re-authorise");
    },
    async reconcileAuthorise() {
      return live as any;
    },
    async fetchAuthorisedPdf() {
      track.pdfFetches += 1;
      return PDF_BYTES;
    },
  };
}

const defaultRevision = {
  id: OBLIGATION_ID,
  job_id: JOB_ID,
  state: "authorised",
  pricing_disposition: "priced_from_canon",
  xero_binding: {
    xero_invoice_id: XERO_ID,
    invoice_number: INVOICE_NUMBER,
    status: "AUTHORISED",
    total: TOTAL,
  },
  proposal: { reference: "AJBR-70271" },
};

Deno.test("pure: unique-constraint detector matches live Bertram error text", () => {
  assertEquals(
    isMakesafeDocketRevisionUniqueConstraintError({
      code: "23505",
      message:
        `duplicate key value violates unique constraint "${MAKESAFE_DOCKET_REVISION_IDEMPOTENCY_CONSTRAINT}"`,
    }),
    true,
  );
  assertEquals(
    isMakesafeDocketRevisionUniqueConstraintError({
      message: "something else",
    }),
    false,
  );
});

Deno.test("pure: identity diffs empty only when all bound fields match", () => {
  const expected = {
    job_id: JOB_ID,
    assembler_version: ASSEMBLER,
    family_matrix_version: FAMILY,
    idempotency_key: sesInvoiceBoundIdempotencyKey(OBLIGATION_ID),
    xero_invoice_id: XERO_ID,
    invoice_number: INVOICE_NUMBER,
    total: TOTAL,
  };
  assertEquals(boundInvoiceIdentityDiffs(expected, priorBoundDocket()), []);
  const wrongTotal = priorBoundDocket({
    xero_binding: {
      xero_invoice_id: XERO_ID,
      invoice_number: INVOICE_NUMBER,
      status: "AUTHORISED",
      total: 900,
    },
  });
  const diffs = boundInvoiceIdentityDiffs(expected, wrongTotal);
  assertEquals(diffs.some((d) => d.startsWith("total:")), true);
});

Deno.test("recovery: binds AUTHORISED PDF to current pre_xero docket without re-approval", async () => {
  const track = { commits: 0, uploads: 0, authorises: 0, creates: 0 };
  const client = recoveryClient({
    revision: defaultRevision,
    currentDocket: preXeroDocket(),
    track,
  });
  const gTrack = { authorises: 0, creates: 0, pdfFetches: 0 };
  const result = await recoverAuthorisedInvoicePdfBind(
    client as any,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "api-key-recovery",
    },
    gateway({ track: gTrack }),
  );
  assertEquals(result.state, "authorised_invoice_bound");
  assertEquals(result.recovery, true);
  assertEquals(result.invoice_create_dispatched, false);
  assertEquals(result.invoice_authorise_dispatched, false);
  assertEquals(result.send_dispatched, false);
  assertEquals(result.invoice.invoice_number, INVOICE_NUMBER);
  assertEquals(result.invoice.xero_invoice_id, XERO_ID);
  assertEquals(result.invoice.total, TOTAL);
  assertEquals(track.commits, 1);
  assertEquals(gTrack.creates, 0);
  assertEquals(gTrack.authorises, 0);
  assertEquals(gTrack.pdfFetches, 1);
  assert(result.pdf_content_hash?.startsWith("sha256:"));
});

Deno.test("recovery: replay is idempotent — second run does not re-commit or re-authorise", async () => {
  const track = { commits: 0, uploads: 0, authorises: 0, creates: 0 };
  const gTrack = { authorises: 0, creates: 0, pdfFetches: 0 };
  const client = recoveryClient({
    revision: defaultRevision,
    currentDocket: preXeroDocket(),
    track,
  });
  const gw = gateway({ track: gTrack });
  const first = await recoverAuthorisedInvoicePdfBind(
    client as any,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "api-key-recovery",
    },
    gw,
  );
  assertEquals(first.state, "authorised_invoice_bound");
  const second = await recoverAuthorisedInvoicePdfBind(
    client as any,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "api-key-recovery",
    },
    gw,
  );
  assertEquals(second.state, "authorised_invoice_already_bound");
  assertEquals(second.recovery, true);
  assertEquals(second.invoice.invoice_number, INVOICE_NUMBER);
  assertEquals(track.commits, 1);
  assertEquals(gTrack.creates, 0);
  assertEquals(gTrack.authorises, 0);
  assertEquals(gTrack.pdfFetches, 1);
});

/**
 * Bertram-shaped failure: prior invoice_bound occupies the obligation key;
 * current is a newer pre_xero (different based_on → different content id).
 * Commit raises real 23505; recovery must adopt, not refuse.
 */
Deno.test("recovery: adopts existing invoice_bound when unique constraint collides (Bertram shape)", async () => {
  const track = { commits: 0, uploads: 0, authorises: 0, creates: 0 };
  const gTrack = { authorises: 0, creates: 0, pdfFetches: 0 };
  const prior = priorBoundDocket();
  const client = recoveryClient({
    revision: defaultRevision,
    // Newer pre_xero is "current" (later committed_at).
    currentDocket: preXeroDocket({
      committed_at: "2026-08-04T09:08:28Z",
    }),
    docketRows: [prior],
    artifacts: [{
      revision_id: PRIOR_BOUND_ID,
      role: "xero_invoice_pdf",
      content_hash: PDF_HASH,
      metadata: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
      },
    }],
    track,
  });
  const first = await recoverAuthorisedInvoicePdfBind(
    client as any,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "api-key-recovery",
    },
    gateway({ track: gTrack }),
  );
  assertEquals(first.state, "authorised_invoice_already_bound");
  assertEquals(first.docket_revision.id, PRIOR_BOUND_ID);
  assertEquals(first.pdf_content_hash, PDF_HASH);
  assertEquals(first.invoice.invoice_number, INVOICE_NUMBER);
  assertEquals(first.invoice.total, TOTAL);
  // Pre-commit adopt: never attempts a second insert.
  assertEquals(track.commits, 0);
  assertEquals(gTrack.creates, 0);
  assertEquals(gTrack.authorises, 0);
  assertEquals(gTrack.pdfFetches, 0);

  const second = await recoverAuthorisedInvoicePdfBind(
    client as any,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "api-key-recovery",
    },
    gateway({ track: gTrack }),
  );
  assertEquals(second.state, "authorised_invoice_already_bound");
  assertEquals(second.docket_revision.id, PRIOR_BOUND_ID);
  assertEquals(track.commits, 0);
});

Deno.test("bind: unique-constraint race adopts matching occupant (post-insert 23505 path)", async () => {
  const track = { commits: 0, uploads: 0, authorises: 0, creates: 0 };
  const prior = priorBoundDocket();
  const client = recoveryClient({
    revision: defaultRevision,
    currentDocket: preXeroDocket(),
    track,
  });
  // Pre-commit SELECT cannot see the occupant; unique index can (race winner).
  client.plantUniqueOccupant(prior, {
    revision_id: PRIOR_BOUND_ID,
    role: "xero_invoice_pdf",
    content_hash: PDF_HASH,
    metadata: {
      xero_invoice_id: XERO_ID,
      invoice_number: INVOICE_NUMBER,
    },
  });

  const result = await bindAuthorisedInvoicePdfToDocket(
    client as any,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      based_on_revision_id: PRE_XERO_DOCKET_ID,
      actor: "api-key-recovery",
      invoice: authorisedInvoice(),
    },
    gateway({}),
  );
  assertEquals(result.state, "authorised_invoice_already_bound");
  assertEquals(result.docket_revision.id, PRIOR_BOUND_ID);
  assertEquals(result.pdf_content_hash, PDF_HASH);
  assertEquals(track.commits, 1); // attempted once, 23505, then adopted
});

Deno.test("recovery: refuses adopt when existing row identity differs (wrong total)", async () => {
  const prior = priorBoundDocket({
    xero_binding: {
      xero_invoice_id: XERO_ID,
      invoice_number: INVOICE_NUMBER,
      status: "AUTHORISED",
      total: 900,
    },
  });
  const client = recoveryClient({
    revision: defaultRevision,
    currentDocket: preXeroDocket(),
    docketRows: [prior],
    artifacts: [{
      revision_id: PRIOR_BOUND_ID,
      role: "xero_invoice_pdf",
      content_hash: PDF_HASH,
      metadata: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
      },
    }],
  });
  const err = await assertRejects(
    () =>
      recoverAuthorisedInvoicePdfBind(
        client as any,
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "api-key-recovery",
        },
        gateway({}),
      ),
    SesActionError,
  );
  assertEquals(err.status, 409);
  assertStringIncludes(err.message, "identity differs");
  assertStringIncludes(err.message, "total:");
});

Deno.test("recovery: refuses adopt when existing row has different invoice number", async () => {
  const prior = priorBoundDocket({
    xero_binding: {
      xero_invoice_id: XERO_ID,
      invoice_number: "INV-9999",
      status: "AUTHORISED",
      total: TOTAL,
    },
  });
  const client = recoveryClient({
    revision: defaultRevision,
    currentDocket: preXeroDocket(),
    docketRows: [prior],
    artifacts: [{
      revision_id: PRIOR_BOUND_ID,
      role: "xero_invoice_pdf",
      content_hash: PDF_HASH,
      metadata: {
        xero_invoice_id: XERO_ID,
        invoice_number: "INV-9999",
      },
    }],
  });
  const err = await assertRejects(
    () =>
      recoverAuthorisedInvoicePdfBind(
        client as any,
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "api-key-recovery",
        },
        gateway({}),
      ),
    SesActionError,
  );
  assertEquals(err.status, 409);
  assertStringIncludes(err.message, "invoice_number:");
});

Deno.test("recovery: refuses when live Xero identity does not match stored binding", async () => {
  const client = recoveryClient({
    revision: defaultRevision,
    currentDocket: preXeroDocket(),
  });
  const err = await assertRejects(
    () =>
      recoverAuthorisedInvoicePdfBind(
        client as any,
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "api-key-recovery",
        },
        gateway({
          live: authorisedInvoice({
            invoice_number: "INV-9999",
            total: 999,
          }),
        }),
      ),
    SesActionError,
  );
  assertEquals(err.status, 409);
  assertStringIncludes(err.message, "does not match");
});

Deno.test("recovery: refuses when live total differs from stored binding", async () => {
  const client = recoveryClient({
    revision: defaultRevision,
    currentDocket: preXeroDocket(),
  });
  const err = await assertRejects(
    () =>
      recoverAuthorisedInvoicePdfBind(
        client as any,
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "api-key-recovery",
        },
        gateway({
          live: authorisedInvoice({ total: 900 }),
        }),
      ),
    SesActionError,
  );
  assertEquals(err.status, 409);
  assertStringIncludes(err.message, "total");
});

Deno.test("recovery: does not bypass stale_review when obligation is not yet authorised", async () => {
  const client = recoveryClient({
    revision: {
      id: OBLIGATION_ID,
      job_id: JOB_ID,
      state: "create_approved",
      pricing_disposition: "priced_from_canon",
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
        status: "DRAFT",
        total: TOTAL,
      },
    },
    currentDocket: preXeroDocket(),
  });
  const err = await assertRejects(
    () =>
      recoverAuthorisedInvoicePdfBind(
        client as any,
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          actor: "api-key-recovery",
        },
        gateway({}),
      ),
    SesActionError,
  );
  assertEquals(err.status, 409);
  assertEquals((err.refusal as { code?: string }).code, "stale_review");
});

Deno.test("execute_ses_invoice_revision routes already-authorised revisions into recovery", async () => {
  const track = { commits: 0, uploads: 0, authorises: 0, creates: 0 };
  const gTrack = { authorises: 0, creates: 0, pdfFetches: 0 };
  const client = recoveryClient({
    revision: defaultRevision,
    currentDocket: preXeroDocket(),
    track,
  });
  const result = await executeSesInvoiceRevisionAction(
    client as any,
    { mode: "api_key", user: null },
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "api-key-recovery",
    },
    gateway({ track: gTrack }),
  );
  assertEquals(result.state, "authorised_invoice_bound");
  assertEquals((result as any).recovery, true);
  assertEquals(gTrack.creates, 0);
  assertEquals(gTrack.authorises, 0);
  assertEquals(track.commits, 1);
});

Deno.test("recovery docket id is content-addressed (same inputs → same bind id)", async () => {
  const pdfHash = await sesSha256(
    Array.from(PDF_BYTES),
    "SecureWorks:ses-docket-artifact-bytes:v1\n",
  );
  const docketHash = await sesSha256({
    based_on_revision_id: PRE_XERO_DOCKET_ID,
    invoice_obligation_revision_id: OBLIGATION_ID,
    xero_invoice_id: XERO_ID,
    pdf_content_hash: pdfHash,
  }, "SecureWorks:ses-invoice-bound-docket:v1\n");
  const first = stableUuidFromSha256(docketHash);
  const second = stableUuidFromSha256(docketHash);
  assertEquals(first, second);
});

Deno.test("adoptExistingInvoiceBoundDocket: pure adopt with matching identity", async () => {
  const prior = priorBoundDocket();
  const client = recoveryClient({
    revision: defaultRevision,
    currentDocket: preXeroDocket(),
    docketRows: [prior],
    artifacts: [{
      revision_id: PRIOR_BOUND_ID,
      role: "xero_invoice_pdf",
      content_hash: PDF_HASH,
      metadata: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
      },
    }],
  });
  const adopted = await adoptExistingInvoiceBoundDocket(client as any, {
    job_id: JOB_ID,
    invoice_obligation_revision_id: OBLIGATION_ID,
    invoice: authorisedInvoice(),
    assembler_version: ASSEMBLER,
    family_matrix_version: FAMILY,
  });
  assertEquals(adopted?.docket_revision.id, PRIOR_BOUND_ID);
  assertEquals(adopted?.pdf_content_hash, PDF_HASH);
});

function assert(condition: unknown, message = "assert failed"): asserts condition {
  if (!condition) throw new Error(message);
}
