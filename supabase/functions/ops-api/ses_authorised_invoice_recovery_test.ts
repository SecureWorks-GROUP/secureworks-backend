// deno-lint-ignore-file no-import-prefix no-explicit-any
/**
 * Authorised-invoice PDF recovery seam.
 *
 * When the obligation is already AUTHORISED and a later docket re-prepare left
 * the current pre_xero docket without the Xero PDF bind, recovery rebinds the
 * exact same invoice without a second human APPROVE. Never mints, re-authorises,
 * voids, or sends.
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  bindAuthorisedInvoicePdfToDocket,
  executeSesInvoiceRevisionAction,
  isSesInvoiceBoundDocketDuplicateKeyError,
  recoverAuthorisedInvoicePdfBind,
  SesActionError,
  type SesXeroGateway,
} from "./ses_reporting_actions.ts";
import { sesSha256, stableUuidFromSha256 } from "./ses_docket_envelope.ts";

const ORG_ID = "00000000-0000-4000-8000-000000000099";
const JOB_ID = "208450c0-7161-4b30-9514-66226b054609";
const OBLIGATION_ID = "68e5432f-0000-4000-8000-000000000001";
const PRE_XERO_DOCKET_ID = "6a55da20-0000-4000-8000-000000000002";
const XERO_ID = "xero-inv-1102";
const INVOICE_NUMBER = "INV-1102";
const TOTAL = 825;

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // %PDF-1.4

const ASSEMBLER_VERSION = "ses-assembler-v1";
const FAMILY_MATRIX_VERSION = "ses-family-matrix-v1";
/** Live truncated constraint name, exactly as Postgres reported it on Bertram. */
const DOCKET_IDEMPOTENCY_CONSTRAINT =
  "makesafe_docket_revisions_job_id_idempotency_key_assembler__key";

interface RecoveryTrack {
  commits: number;
  uploads: number;
  authorises: number;
  creates: number;
  observed_effects?: number;
}

/**
 * Mirrors the shipped migration
 * `20260804010000_ses_invoice_bound_docket_idempotent_adopt.sql`, which scopes
 * the invoice-bound key to the pre_xero base so a re-prepare can bind the same
 * AUTHORISED invoice onto the new current pack. Passing an empty base models a
 * legacy (pre-migration) row written under the obligation-only key.
 *
 * This is a TEST-SIDE RESTATEMENT of SQL logic, not the SQL itself — see the
 * honesty note at the head of the unique-index tests below.
 */
function sesInvoiceBoundIdempotencyKey(
  obligationRevisionId: string,
  basedOnRevisionId: string,
): string {
  return basedOnRevisionId
    ? `ses-invoice-bound:${obligationRevisionId}:${basedOnRevisionId}`
    : `ses-invoice-bound:${obligationRevisionId}`;
}

/** UNIQUE (job_id, idempotency_key, assembler_version, family_matrix_version). */
function docketUniqueKey(row: {
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
  ].join("\u0000");
}

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

function recoveryClient(opts: {
  revision: Record<string, any>;
  currentDocket: Record<string, any>;
  /** Historical invoice_bound rows (e.g. prior base) for adopt-on-duplicate. */
  existingBoundDockets?: Array<Record<string, any>>;
  artifactsByRevision?: Record<string, Array<Record<string, any>>>;
  artifacts?: Array<Record<string, any>>;
  commitReturns?: Record<string, any> | null;
  /** Simulate live 23505 unique key collision on commit. */
  commitDuplicateKey?: boolean;
  track?: RecoveryTrack;
}) {
  const track = opts.track || {
    commits: 0,
    uploads: 0,
    authorises: 0,
    creates: 0,
  };
  const artifacts = opts.artifacts || [];
  const artifactsByRevision = opts.artifactsByRevision || {};
  let committedDocket = opts.commitReturns ?? null;
  let observedEffect: Record<string, any> | null = null;
  const existingBound = opts.existingBoundDockets || [];
  let lastArtifactRevisionId: string | null = null;
  // Seed the unique index from any pre-existing invoice_bound rows, using each
  // row's own stored idempotency_key so a legacy obligation-only occupant and a
  // migration-era based_on-scoped occupant are both modelled faithfully.
  const uniqueIndex = new Map<string, string>();
  for (const row of existingBound) {
    if (!row?.id) continue;
    uniqueIndex.set(
      docketUniqueKey({
        job_id: String(row.job_id || JOB_ID),
        idempotency_key: String(
          row.idempotency_key ??
            sesInvoiceBoundIdempotencyKey(
              String(row.invoice_obligation_revision_id || ""),
              String(row.based_on_revision_id || ""),
            ),
        ),
        assembler_version: ASSEMBLER_VERSION,
        family_matrix_version: FAMILY_MATRIX_VERSION,
      }),
      String(row.id),
    );
  }

  function rowFor(table: string) {
    if (table === "makesafe_invoice_obligation_revisions") {
      return opts.revision;
    }
    if (table === "makesafe_docket_revisions_current") {
      return committedDocket && committedDocket.stage === "invoice_bound"
        ? committedDocket
        : opts.currentDocket;
    }
    if (table === "makesafe_docket_revisions") {
      const list = [
        ...(committedDocket ? [committedDocket] : []),
        ...existingBound,
        opts.currentDocket,
      ];
      // Dedup by id, newest-first for order().
      const seen = new Set<string>();
      const deduped: any[] = [];
      for (const row of list) {
        if (!row?.id || seen.has(row.id)) continue;
        seen.add(row.id);
        deduped.push(row);
      }
      return deduped;
    }
    if (table === "makesafe_readiness_current_v2") {
      return {
        readiness_revision: "ready-1",
        dependency_generation: 1,
        ready: true,
      };
    }
    if (table === "makesafe_docket_artifacts") {
      if (lastArtifactRevisionId && artifactsByRevision[lastArtifactRevisionId]) {
        return artifactsByRevision[lastArtifactRevisionId];
      }
      if (
        committedDocket?.stage === "invoice_bound" &&
        artifacts.length === 0
      ) {
        return [{
          role: "xero_invoice_pdf",
          content_hash: committedDocket.xero_binding?.pdf_content_hash ||
            "sha256:aabb",
          metadata: {
            xero_invoice_id: XERO_ID,
            invoice_number: INVOICE_NUMBER,
          },
        }];
      }
      return artifacts;
    }
    if (
      table === "job_assignments" || table === "job_service_reports" ||
      table === "xero_invoices"
    ) {
      return [];
    }
    return null;
  }

  return {
    track,
    from(table: string) {
      const filters: Record<string, string> = {};
      const builder: any = {
        select: () => builder,
        eq: (col: string, val: string) => {
          filters[col] = val;
          if (table === "makesafe_docket_artifacts" && col === "revision_id") {
            lastArtifactRevisionId = val;
          }
          return builder;
        },
        in: () => builder,
        not: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        update: () => builder,
        upsert: () => builder,
        maybeSingle: async () => {
          const data = rowFor(table);
          if (Array.isArray(data)) {
            // Filter invoice_bound list if eq filters present.
            let rows = data;
            if (table === "makesafe_docket_revisions" && filters.stage) {
              rows = rows.filter((r) => r.stage === filters.stage);
            }
            if (
              table === "makesafe_docket_revisions" &&
              filters.invoice_obligation_revision_id
            ) {
              rows = rows.filter((r) =>
                r.invoice_obligation_revision_id ===
                  filters.invoice_obligation_revision_id
              );
            }
            return { data: rows[0] ?? null, error: null };
          }
          return { data, error: null };
        },
        single: async () => {
          const data = rowFor(table);
          return { data: Array.isArray(data) ? data[0] : data, error: null };
        },
        then: (resolve: any, reject: any) => {
          const raw = rowFor(table);
          let rows: any[] = Array.isArray(raw) ? raw : (raw ? [raw] : []);
          if (table === "makesafe_docket_revisions") {
            if (filters.stage) {
              rows = rows.filter((r: any) => r.stage === filters.stage);
            }
            if (filters.invoice_obligation_revision_id) {
              rows = rows.filter((r: any) =>
                r.invoice_obligation_revision_id ===
                  filters.invoice_obligation_revision_id
              );
            }
            if (filters.job_id) {
              rows = rows.filter((r: any) => r.job_id === filters.job_id);
            }
          }
          return Promise.resolve({
            data: rows,
            error: null,
          }).then(resolve, reject);
        },
      };
      return builder;
    },
    async rpc(name: string, args: Record<string, any>) {
      if (name === "claim_ses_external_effect_v1") {
        const effect = args.p_effect || {};
        if (!observedEffect) {
          observedEffect = {
            ...effect,
            id: "observed-effect-1",
            state: "reserved",
          };
          return {
            data: {
              effect: { ...observedEffect },
              claim_mode: "dispatch",
              duplicate_refused: false,
            },
            error: null,
          };
        }
        return {
          data: {
            effect: { ...observedEffect },
            claim_mode: observedEffect.state === "confirmed"
              ? "confirmed"
              : "reconcile",
            duplicate_refused: true,
          },
          error: null,
        };
      }
      if (name === "transition_ses_external_effect_v1") {
        if (!observedEffect) {
          return {
            data: null,
            error: { code: "P0002", message: "external effect does not exist" },
          };
        }
        if (
          observedEffect.state !== args.p_from_state ||
          args.p_to_state !== "confirmed" ||
          args.p_event_kind !== "provider_observed_without_dispatch"
        ) {
          return {
            data: null,
            error: { code: "23514", message: "invalid observed transition" },
          };
        }
        observedEffect = {
          ...observedEffect,
          state: "confirmed",
          external_id: args.p_detail?.external_id || null,
          provider_digest: args.p_detail?.provider_digest || null,
        };
        track.observed_effects = (track.observed_effects || 0) + 1;
        return { data: { ...observedEffect }, error: null };
      }
      if (name === "commit_ses_invoice_bound_docket_v1") {
        track.commits += 1;
        const binding = args.p_binding || {};
        const pdf = args.p_pdf_artifact || {};
        if (opts.commitDuplicateKey) {
          return {
            data: null,
            error: {
              message:
                'duplicate key value violates unique constraint "makesafe_docket_revisions_job_id_idempotency_key_assembler__key"',
            },
          };
        }
        // In-process stand-in for the migration's
        // UNIQUE (job_id, idempotency_key, assembler_version,
        // family_matrix_version). The collision therefore emerges from the KEY
        // SHAPE rather than from a test flag, which is the gap that let the
        // first recovery deploy pass its suite and then die on the live index.
        const occupantId = uniqueIndex.get(
          docketUniqueKey({
            job_id: String(binding.job_id || ""),
            idempotency_key: sesInvoiceBoundIdempotencyKey(
              String(binding.invoice_obligation_revision_id || ""),
              String(binding.based_on_revision_id || ""),
            ),
            assembler_version: ASSEMBLER_VERSION,
            family_matrix_version: FAMILY_MATRIX_VERSION,
          }),
        );
        if (occupantId && occupantId !== binding.id) {
          return {
            data: null,
            error: {
              code: "23505",
              message:
                `duplicate key value violates unique constraint "${DOCKET_IDEMPOTENCY_CONSTRAINT}"`,
            },
          };
        }
        // Idempotent SQL path: same id returns existing row.
        if (
          committedDocket &&
          committedDocket.id === binding.id &&
          committedDocket.stage === "invoice_bound"
        ) {
          return { data: committedDocket, error: null };
        }
        committedDocket = {
          id: binding.id,
          job_id: binding.job_id,
          stage: "invoice_bound",
          invoice_obligation_revision_id: binding.invoice_obligation_revision_id,
          based_on_revision_id: binding.based_on_revision_id,
          output_content_hash: binding.output_content_hash,
          xero_binding: binding.xero_binding,
          pre_xero_docs_ready: true,
          envelope: { v2: { classification: {}, items: {} } },
          email_drafts: {},
          attendance_cycle_ids: opts.currentDocket.attendance_cycle_ids || [],
        };
        uniqueIndex.set(
          docketUniqueKey({
            job_id: String(binding.job_id || JOB_ID),
            idempotency_key: sesInvoiceBoundIdempotencyKey(
              String(binding.invoice_obligation_revision_id || ""),
              String(binding.based_on_revision_id || ""),
            ),
            assembler_version: ASSEMBLER_VERSION,
            family_matrix_version: FAMILY_MATRIX_VERSION,
          }),
          String(binding.id),
        );
        // After first commit, current docket becomes invoice_bound.
        opts.currentDocket = committedDocket;
        artifacts.splice(0, artifacts.length, {
          role: "xero_invoice_pdf",
          content_hash: pdf.content_hash,
          metadata: pdf.metadata || {},
        });
        return { data: committedDocket, error: null };
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
          // Second upload reports already-exists (idempotent storage).
          if (track.uploads > 1) {
            return {
              data: null,
              error: { message: "The resource already exists" },
            };
          }
          return { data: { path: "ok" }, error: null };
        },
        download: async () => ({ data: null, error: { message: "unused" } }),
        createSignedUrl: async () => ({ data: null, error: { message: "unused" } }),
      }),
    },
  };
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

Deno.test("recovery: binds AUTHORISED PDF to current pre_xero docket without re-approval", async () => {
  const track: RecoveryTrack = {
    commits: 0,
    uploads: 0,
    authorises: 0,
    creates: 0,
  };
  const client = recoveryClient({
    revision: {
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
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      attendance_cycle_ids: ["cycle-1"],
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
      local_invoice_proposal: { builder_reference: "AJBR-70271" },
    },
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
  assertEquals(track.observed_effects, 1);
  assertEquals(gTrack.creates, 0);
  assertEquals(gTrack.authorises, 0);
  assertEquals(gTrack.pdfFetches, 1);
  assert(result.pdf_content_hash?.startsWith("sha256:"));
});

Deno.test("recovery: replay is idempotent — second run does not re-commit or re-authorise", async () => {
  const track: RecoveryTrack = {
    commits: 0,
    uploads: 0,
    authorises: 0,
    creates: 0,
  };
  const gTrack = { authorises: 0, creates: 0, pdfFetches: 0 };
  const client = recoveryClient({
    revision: {
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
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      attendance_cycle_ids: ["cycle-1"],
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
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
  // First run commits once; second hits the already-bound path (no second commit).
  assertEquals(track.commits, 1);
  assertEquals(track.observed_effects, 1);
  assertEquals(gTrack.creates, 0);
  assertEquals(gTrack.authorises, 0);
  // PDF may be fetched once on first bind only.
  assertEquals(gTrack.pdfFetches, 1);
});

Deno.test("recovery: refuses when live Xero identity does not match stored binding", async () => {
  const client = recoveryClient({
    revision: {
      id: OBLIGATION_ID,
      job_id: JOB_ID,
      state: "authorised",
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
        status: "AUTHORISED",
        total: TOTAL,
      },
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
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
    revision: {
      id: OBLIGATION_ID,
      job_id: JOB_ID,
      state: "authorised",
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
        status: "AUTHORISED",
        total: TOTAL,
      },
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
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
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
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
    revision: {
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
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      attendance_cycle_ids: ["cycle-1"],
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
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

Deno.test("isSesInvoiceBoundDocketDuplicateKeyError recognises live constraint name", () => {
  assert(
    isSesInvoiceBoundDocketDuplicateKeyError({
      message:
        'duplicate key value violates unique constraint "makesafe_docket_revisions_job_id_idempotency_key_assembler__key"',
    }),
  );
  assert(
    !isSesInvoiceBoundDocketDuplicateKeyError({
      message: "the AUTHORISED Xero invoice is not confirmed by the exact effect ledger",
    }),
  );
});

Deno.test("bind adopts an existing same-INV, same-base docket (true replay, no second mint)", async () => {
  const EXISTING_BOUND_ID = "aaaaaaaa-0000-4000-8000-000000000099";
  const existingBound = {
    id: EXISTING_BOUND_ID,
    job_id: JOB_ID,
    stage: "invoice_bound",
    invoice_obligation_revision_id: OBLIGATION_ID,
    // Bound from the exact pre_xero base under review: the reviewed pack bytes.
    based_on_revision_id: PRE_XERO_DOCKET_ID,
    idempotency_key: `ses-invoice-bound:${OBLIGATION_ID}`,
    xero_binding: {
      xero_invoice_id: XERO_ID,
      invoice_number: INVOICE_NUMBER,
      status: "AUTHORISED",
      total: TOTAL,
      pdf_content_hash: "sha256:existingpdfhash000000000000000000000000000000000000000000000000",
    },
  };
  const track = { commits: 0, uploads: 0, authorises: 0, creates: 0 };
  const gTrack = { authorises: 0, creates: 0, pdfFetches: 0 };
  const client = recoveryClient({
    revision: {
      id: OBLIGATION_ID,
      job_id: JOB_ID,
      state: "authorised",
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
        status: "AUTHORISED",
        total: TOTAL,
      },
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
    existingBoundDockets: [existingBound],
    artifactsByRevision: {
      [EXISTING_BOUND_ID]: [{
        role: "xero_invoice_pdf",
        content_hash:
          "sha256:existingpdfhash000000000000000000000000000000000000000000000000",
        metadata: {
          xero_invoice_id: XERO_ID,
          invoice_number: INVOICE_NUMBER,
        },
      }],
    },
    commitDuplicateKey: true,
    track,
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
    gateway({ track: gTrack }),
  );
  assertEquals(result.state, "authorised_invoice_already_bound");
  assertEquals(result.adopted_existing, true);
  assertEquals(result.docket_revision.id, EXISTING_BOUND_ID);
  assertEquals(result.invoice.invoice_number, INVOICE_NUMBER);
  assertEquals(result.invoice.xero_invoice_id, XERO_ID);
  assertEquals(result.invoice.total, TOTAL);
  // The reviewed base is already bound, so nothing is re-committed and the Xero
  // PDF is not even re-fetched.
  assertEquals(track.commits, 0);
  assertEquals(gTrack.pdfFetches, 0);
  assertEquals(gTrack.creates, 0);
  assertEquals(gTrack.authorises, 0);
});

Deno.test("bind refuses a same-INV bind built on a DIFFERENT pre_xero base — never adopts superseded pack bytes", async () => {
  const EXISTING_BOUND_ID = "aaaaaaaa-0000-4000-8000-00000000009a";
  const OLD_BASE_ID = "bbbbbbbb-0000-4000-8000-000000000088";
  const existingBound = {
    id: EXISTING_BOUND_ID,
    job_id: JOB_ID,
    stage: "invoice_bound",
    invoice_obligation_revision_id: OBLIGATION_ID,
    based_on_revision_id: OLD_BASE_ID,
    idempotency_key: `ses-invoice-bound:${OBLIGATION_ID}`,
    xero_binding: {
      xero_invoice_id: XERO_ID,
      invoice_number: INVOICE_NUMBER,
      status: "AUTHORISED",
      total: TOTAL,
      pdf_content_hash:
        "sha256:supersededpdf00000000000000000000000000000000000000000000000000",
    },
  };
  const track = { commits: 0, uploads: 0, authorises: 0, creates: 0 };
  const gTrack = { authorises: 0, creates: 0, pdfFetches: 0 };
  const client = recoveryClient({
    revision: {
      id: OBLIGATION_ID,
      job_id: JOB_ID,
      state: "authorised",
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
        status: "AUTHORISED",
        total: TOTAL,
      },
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
    existingBoundDockets: [existingBound],
    artifactsByRevision: {
      [EXISTING_BOUND_ID]: [{
        role: "xero_invoice_pdf",
        content_hash:
          "sha256:supersededpdf00000000000000000000000000000000000000000000000000",
        metadata: {
          xero_invoice_id: XERO_ID,
          invoice_number: INVOICE_NUMBER,
        },
      }],
    },
    commitDuplicateKey: true,
    track,
  });
  const error = await assertRejects(
    () =>
      bindAuthorisedInvoicePdfToDocket(
        client as any,
        {
          org_id: ORG_ID,
          job_id: JOB_ID,
          invoice_obligation_revision_id: OBLIGATION_ID,
          based_on_revision_id: PRE_XERO_DOCKET_ID,
          actor: "api-key-recovery",
          invoice: authorisedInvoice(),
        },
        gateway({ track: gTrack }),
      ),
    SesActionError,
  );
  assertEquals(error.status, 409);
  // The refusal must name what differs, not just say "duplicate key".
  assert(String(error.message).includes(OLD_BASE_ID));
  assert(String(error.message).includes(PRE_XERO_DOCKET_ID));
  assertEquals(gTrack.creates, 0);
  assertEquals(gTrack.authorises, 0);
});

Deno.test("recovery adopts the existing INV-1102 bind when it is the current pack's own bind", async () => {
  const EXISTING_BOUND_ID = "cccccccc-0000-4000-8000-000000000077";
  const existingBound = {
    id: EXISTING_BOUND_ID,
    job_id: JOB_ID,
    stage: "invoice_bound",
    invoice_obligation_revision_id: OBLIGATION_ID,
    based_on_revision_id: PRE_XERO_DOCKET_ID,
    idempotency_key: `ses-invoice-bound:${OBLIGATION_ID}`,
    xero_binding: {
      xero_invoice_id: XERO_ID,
      invoice_number: INVOICE_NUMBER,
      status: "AUTHORISED",
      total: TOTAL,
      pdf_content_hash: "sha256:adoptedpdf0000000000000000000000000000000000000000000000000000",
    },
  };
  const track = { commits: 0, uploads: 0, authorises: 0, creates: 0 };
  const client = recoveryClient({
    revision: {
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
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      attendance_cycle_ids: ["cycle-1"],
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
    existingBoundDockets: [existingBound],
    artifactsByRevision: {
      [EXISTING_BOUND_ID]: [{
        role: "xero_invoice_pdf",
        content_hash:
          "sha256:adoptedpdf0000000000000000000000000000000000000000000000000000",
        metadata: {
          xero_invoice_id: XERO_ID,
          invoice_number: INVOICE_NUMBER,
        },
      }],
    },
    commitDuplicateKey: true,
    track,
  });
  const result = await recoverAuthorisedInvoicePdfBind(
    client as any,
    {
      org_id: ORG_ID,
      job_id: JOB_ID,
      invoice_obligation_revision_id: OBLIGATION_ID,
      actor: "api-key-recovery",
    },
    gateway({}),
  );
  assertEquals(result.state, "authorised_invoice_already_bound");
  assertEquals(result.recovery, true);
  assertEquals(result.docket_revision.id, EXISTING_BOUND_ID);
  assertEquals(result.invoice.invoice_number, "INV-1102");
  assertEquals(result.invoice.total, 825);
  assertEquals(result.send_dispatched, false);
  assertEquals(result.invoice_create_dispatched, false);
  assertEquals(result.invoice_authorise_dispatched, false);
  assertEquals(track.commits, 0);
});

Deno.test("bind refuses to adopt a different invoice number on duplicate key", async () => {
  const existingBound = {
    id: "eeeeeeee-0000-4000-8000-000000000055",
    job_id: JOB_ID,
    stage: "invoice_bound",
    invoice_obligation_revision_id: OBLIGATION_ID,
    based_on_revision_id: PRE_XERO_DOCKET_ID,
    xero_binding: {
      xero_invoice_id: "other-xero",
      invoice_number: "INV-9999",
      status: "AUTHORISED",
      total: 999,
    },
  };
  const client = recoveryClient({
    revision: {
      id: OBLIGATION_ID,
      job_id: JOB_ID,
      state: "authorised",
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
        status: "AUTHORISED",
        total: TOTAL,
      },
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
    existingBoundDockets: [existingBound],
    commitDuplicateKey: true,
  });
  const err = await assertRejects(
    () =>
      bindAuthorisedInvoicePdfToDocket(
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
      ),
    SesActionError,
  );
  assertEquals(err.status, 409);
  assertStringIncludes(err.message, "could not be bound");
});

function assert(condition: unknown, message = "assert failed"): asserts condition {
  if (!condition) throw new Error(message);
}

/*
 * ---------------------------------------------------------------------------
 * Real-constraint cases.
 *
 * The tests above that use `commitDuplicateKey` assert behaviour given a
 * collision. These two instead make the collision EMERGE from the composite key
 * shape, via an in-process stand-in for
 * UNIQUE (job_id, idempotency_key, assembler_version, family_matrix_version).
 * That is the axis that burned us: the first recovery deploy passed 84 tests
 * whose "idempotency" short-circuited on the content-addressed docket id, so
 * nothing in the suite could see the live index at all.
 *
 * HONESTY NOTE — what these still do NOT prove: the live PostgREST error
 * envelope, the real `commit_ses_invoice_bound_docket_v1` body (the key
 * derivation here is a test-side restatement of the migration's SQL, and could
 * drift from it), and concurrent advisory-lock behaviour. They narrow the mock
 * gap; they do not close it. A live readback on the named card is still
 * required after any deploy that touches this seam.
 * ---------------------------------------------------------------------------
 */

Deno.test("unique index: replaying the SAME base collides on the live key and adopts", async () => {
  const EXISTING_BOUND_ID = "f0000000-0000-4000-8000-0000000000a1";
  const existingBound = {
    id: EXISTING_BOUND_ID,
    job_id: JOB_ID,
    stage: "invoice_bound",
    invoice_obligation_revision_id: OBLIGATION_ID,
    based_on_revision_id: PRE_XERO_DOCKET_ID,
    // Written by the migration-era commit: key scoped to the base.
    idempotency_key: sesInvoiceBoundIdempotencyKey(
      OBLIGATION_ID,
      PRE_XERO_DOCKET_ID,
    ),
    xero_binding: {
      xero_invoice_id: XERO_ID,
      invoice_number: INVOICE_NUMBER,
      status: "AUTHORISED",
      total: TOTAL,
      pdf_content_hash:
        "sha256:samebasepdf0000000000000000000000000000000000000000000000000000",
    },
  };
  const track = { commits: 0, uploads: 0, authorises: 0, creates: 0 };
  const gTrack = { authorises: 0, creates: 0, pdfFetches: 0 };
  const client = recoveryClient({
    revision: {
      id: OBLIGATION_ID,
      job_id: JOB_ID,
      state: "authorised",
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
        status: "AUTHORISED",
        total: TOTAL,
      },
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
    existingBoundDockets: [existingBound],
    artifactsByRevision: {
      [EXISTING_BOUND_ID]: [{
        role: "xero_invoice_pdf",
        content_hash:
          "sha256:samebasepdf0000000000000000000000000000000000000000000000000000",
        metadata: {
          xero_invoice_id: XERO_ID,
          invoice_number: INVOICE_NUMBER,
        },
      }],
    },
    track,
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
    gateway({ track: gTrack }),
  );
  assertEquals(result.state, "authorised_invoice_already_bound");
  assertEquals(result.docket_revision.id, EXISTING_BOUND_ID);
  assertEquals(gTrack.creates, 0);
  assertEquals(gTrack.authorises, 0);
});

Deno.test("unique index: the Bertram shape (legacy key, superseded base) no longer collides — it mints a bind on the CURRENT pack", async () => {
  const LEGACY_BOUND_ID = "f0000000-0000-4000-8000-0000000000b2";
  const SUPERSEDED_BASE_ID = "f0000000-0000-4000-8000-0000000000b3";
  // Exactly the live Bertram row: bound before the migration, so its key is the
  // obligation-only form, and its base is the pre_xero docket that a later
  // re-prepare superseded.
  const legacyBound = {
    id: LEGACY_BOUND_ID,
    job_id: JOB_ID,
    stage: "invoice_bound",
    invoice_obligation_revision_id: OBLIGATION_ID,
    based_on_revision_id: SUPERSEDED_BASE_ID,
    idempotency_key: sesInvoiceBoundIdempotencyKey(OBLIGATION_ID, ""),
    xero_binding: {
      xero_invoice_id: XERO_ID,
      invoice_number: INVOICE_NUMBER,
      status: "AUTHORISED",
      total: TOTAL,
      pdf_content_hash:
        "sha256:legacybasepdf00000000000000000000000000000000000000000000000000",
    },
  };
  const track = { commits: 0, uploads: 0, authorises: 0, creates: 0 };
  const gTrack = { authorises: 0, creates: 0, pdfFetches: 0 };
  const client = recoveryClient({
    revision: {
      id: OBLIGATION_ID,
      job_id: JOB_ID,
      state: "authorised",
      xero_binding: {
        xero_invoice_id: XERO_ID,
        invoice_number: INVOICE_NUMBER,
        status: "AUTHORISED",
        total: TOTAL,
      },
    },
    currentDocket: {
      id: PRE_XERO_DOCKET_ID,
      job_id: JOB_ID,
      stage: "pre_xero",
      invoice_obligation_revision_id: OBLIGATION_ID,
      envelope: { v2: { classification: {}, items: {} } },
      email_drafts: {},
    },
    existingBoundDockets: [legacyBound],
    artifactsByRevision: {
      [LEGACY_BOUND_ID]: [{
        role: "xero_invoice_pdf",
        content_hash:
          "sha256:legacybasepdf00000000000000000000000000000000000000000000000000",
        metadata: {
          xero_invoice_id: XERO_ID,
          invoice_number: INVOICE_NUMBER,
        },
      }],
    },
    track,
  });
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
  // The based_on-scoped key does not collide with the legacy row, so the same
  // AUTHORISED invoice binds to the CURRENT pack. Adopting the legacy row
  // instead would have reported success while the current pack stayed unbound.
  assertEquals(result.state, "authorised_invoice_bound");
  assertEquals(result.docket_revision.based_on_revision_id, PRE_XERO_DOCKET_ID);
  assert(result.docket_revision.id !== LEGACY_BOUND_ID);
  assertEquals(track.commits, 1);
  // Money is untouched: no second mint, no re-authorise, no send.
  assertEquals(gTrack.creates, 0);
  assertEquals(gTrack.authorises, 0);
  assertEquals(result.invoice_create_dispatched, false);
  assertEquals(result.invoice_authorise_dispatched, false);
  assertEquals(result.send_dispatched, false);
});
