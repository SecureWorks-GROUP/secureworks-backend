// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertSesReleaseRevisionIsCurrent,
  commitSesReleaseRevisionPlanAction,
  executeSesReleaseRevisionAction,
  loadSesCockpitDocket,
  prepareSesReleaseRevisionAction,
  SesActionError,
  type SesMailGateway,
  type SesReleaseXeroReader,
  type SesXeroGateway,
} from "./ses_reporting_actions.ts";
import {
  createSupabaseUnifiedReleaseDeps,
  unifiedSesReleaseAction,
} from "./ses_unified_release.ts";
import { SES_ASSESSMENT_RECIPE_VERSION } from "./ses_family_matrix.ts";
import type {
  SesEffectState,
  SesExternalEffect,
} from "./ses_external_effects.ts";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const sealedWorkflowContractFixture = {
  assertWorkflowReleaseContract: async () => `sha256:${"f".repeat(64)}`,
};
const JOB_ID = "10000000-0000-4000-8000-000000000001";
const DOCKET_ID = "20000000-0000-4000-8000-000000000001";
const OBLIGATION_ID = "30000000-0000-4000-8000-000000000001";
const NO_CHARGE_JOB_ID = "10000000-0000-4000-8000-000000000002";
const NO_CHARGE_DOCKET_ID = "20000000-0000-4000-8000-000000000002";
const NO_CHARGE_OBLIGATION_ID = "30000000-0000-4000-8000-000000000002";
const CHANGED_NO_CHARGE_DOCKET_ID = "20000000-0000-4000-8000-000000000003";
const USER = {
  id: "40000000-0000-4000-8000-000000000001",
  role: "admin",
  email: "captain@example.test",
};
const auth = { mode: "jwt" as const, user: USER };
const encode = (value: string) => new TextEncoder().encode(value);

function textPdf(lines: string[]): Uint8Array {
  const escaped = lines.map((line) =>
    line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")
  );
  const content = `BT /F1 10 Tf 72 760 Td ${
    escaped.map((line) => `(${line}) Tj 0 -14 Td`).join(" ")
  } ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${encode(content).length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(encode(pdf).length);
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = encode(pdf).length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${
    objects.length + 1
  } /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encode(pdf);
}

const INVOICE_LINES = [
  "Reference SES-SYNTHETIC-4477",
  "Customer Synthetic Insurance Builder",
  "Site Suburb Joondalup Western Australia",
  "Description Emergency make-safe attendance",
  "Line one attendance labour quantity 1 unit price 454.55",
  "Subtotal 454.55 GST 45.45 Total AUD 500.00",
];

function invoicePdf(
  status: "DRAFT" | "AUTHORISED",
  number: string,
  altered = false,
): Uint8Array {
  return textPdf([
    `Invoice Number ${number}`,
    `Invoice Status ${status}`,
    ...INVOICE_LINES.map((line) =>
      altered && line.startsWith("Line one")
        ? "Line one UNAPPROVED surcharge quantity 1 unit price 454.55"
        : line
    ),
  ]);
}

function optionBHarness(
  options: boolean | {
    alteredAuthorisedPdf?: boolean;
    failRatifyOnce?: boolean;
    failReleaseApprovalOnce?: boolean;
    mixedNoCharge?: boolean;
    advanceNoChargeDuringAuthorise?: boolean;
    supersedeSourceDuringAuthorise?: boolean;
    prepareCorrectionAfterBind?: boolean;
    prepareCorrectionDuringFinalCommit?: boolean;
  } = false,
) {
  const alteredAuthorisedPdf = typeof options === "boolean"
    ? options
    : options.alteredAuthorisedPdf === true;
  let failRatifyOnce = typeof options === "object" &&
    options.failRatifyOnce === true;
  let failReleaseApprovalOnce = typeof options === "object" &&
    options.failReleaseApprovalOnce === true;
  const mixedNoCharge = typeof options === "object" &&
    options.mixedNoCharge === true;
  const advanceNoChargeDuringAuthorise = typeof options === "object" &&
    options.advanceNoChargeDuringAuthorise === true;
  const supersedeSourceDuringAuthorise = typeof options === "object" &&
    options.supersedeSourceDuringAuthorise === true;
  const prepareCorrectionAfterBind = typeof options === "object" &&
    options.prepareCorrectionAfterBind === true;
  const prepareCorrectionDuringFinalCommit = typeof options === "object" &&
    options.prepareCorrectionDuringFinalCommit === true;
  const draftInvoice = {
    xero_invoice_id: "xero-synthetic-4477",
    invoice_number: "DRAFT-4477",
    status: "DRAFT",
    reference: "SES-SYNTHETIC-4477",
    total: 500,
  };
  const authorisedInvoice = {
    ...draftInvoice,
    invoice_number: "INV-4477",
    status: "AUTHORISED",
  };
  const draftPdf = invoicePdf("DRAFT", draftInvoice.invoice_number);
  const authorisedPdf = invoicePdf(
    "AUTHORISED",
    authorisedInvoice.invoice_number,
    alteredAuthorisedPdf,
  );
  let xeroAuthorised = false;
  let xeroAuthoriseDispatches = 0;
  const currentDocketByJobId = new Map<string, string>([[JOB_ID, DOCKET_ID]]);
  if (mixedNoCharge) {
    currentDocketByJobId.set(NO_CHARGE_JOB_ID, NO_CHARGE_DOCKET_ID);
  }
  let clock = 0;
  const order: string[] = [];
  const sends: string[] = [];
  const approvals: any[] = [];
  const effects = new Map<string, SesExternalEffect>();
  const routeProofs: any[] = [];
  const closeouts: any[] = [];
  const reviews = new Map<string, any>();
  const releases: any[] = [];
  const releaseMembers: any[] = [];
  const releaseRoutes: any[] = [];
  const artifacts: any[] = [];
  const dockets: any[] = [{
    id: DOCKET_ID,
    org_id: ORG_ID,
    job_id: JOB_ID,
    stage: "pre_xero",
    state: "prepared",
    output_content_hash:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    assembler_version: "ses-assembler-v1",
    family_matrix_version: "ses-builder-family-matrix/2026-08-13.1",
    invoice_obligation_revision_id: OBLIGATION_ID,
    attendance_cycle_ids: ["cycle-synthetic"],
    pre_xero_docs_ready: true,
    blockers: [],
    envelope: {
      v2: {
        classification: {
          family: "assessment_quote",
          job_number: "SWMS-SYNTHETIC",
          assessment_outbound_recipe_version: SES_ASSESSMENT_RECIPE_VERSION,
        },
        routing: { invoice_to: "builder@example.test" },
        items: { draft_builder_report_email: { state: "not_applicable" } },
      },
    },
    review_spec: { cards: [{ family: "assessment_quote" }] },
    local_invoice_proposal: { builder_reference: "SES-SYNTHETIC-4477" },
    email_drafts: {
      INVOICE_EMAIL_DRAFT:
        "To: builder@example.test\nSubject: SES-SYNTHETIC-4477 - invoice\nAttachments:\n\nPlease find attached the invoice. Thank you.",
    },
    committed_at: "2026-08-14T00:00:00.000Z",
  }];
  if (mixedNoCharge) {
    dockets.push({
      ...dockets[0],
      id: NO_CHARGE_DOCKET_ID,
      job_id: NO_CHARGE_JOB_ID,
      output_content_hash:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      invoice_obligation_revision_id: NO_CHARGE_OBLIGATION_ID,
      attendance_cycle_ids: ["cycle-no-charge"],
      local_invoice_proposal: null,
    });
    reviews.set(NO_CHARGE_DOCKET_ID, {
      docket_revision_id: NO_CHARGE_DOCKET_ID,
      docket_output_content_hash:
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      assembler_version: "ses-assembler-v1",
      family_matrix_version: "ses-builder-family-matrix/2026-08-13.1",
      review_state: "signed_off",
    });
  }
  const obligation: any = {
    id: OBLIGATION_ID,
    job_id: JOB_ID,
    state: "create_executed",
    pricing_disposition: "priced_from_canon",
    proposal: {
      reference: draftInvoice.reference,
      contact_name: "Synthetic Insurance Builder",
      currency: "AUD",
      lines: [{
        description: "Emergency make-safe",
        quantity: 1,
        unit_amount: 454.55,
      }],
      totals: { inc: 500 },
    },
    duplicate_probe: { allows_create: false, ambiguity: "none" },
    blockers: [],
    xero_binding: { ...draftInvoice },
  };
  const noChargeObligation: any = {
    id: NO_CHARGE_OBLIGATION_ID,
    job_id: NO_CHARGE_JOB_ID,
    state: "proposed",
    pricing_disposition: "no_additional_charge",
    proposal: null,
    duplicate_probe: { allows_create: false, ambiguity: "none" },
    blockers: [],
    xero_binding: null,
  };
  const xeroRows: any[] = [{
    id: "xero-row-1",
    org_id: ORG_ID,
    job_id: JOB_ID,
    invoice_obligation_revision_id: OBLIGATION_ID,
    invoice_type: "ACCREC",
    reference_normalized: "sessynthetic4477",
    ...draftInvoice,
  }];
  const readinessRows: any[] = [
    {
      job_id: JOB_ID,
      readiness_revision: "ready-synthetic",
      dependency_generation: 1,
      ready: true,
      blockers: [],
    },
    ...(mixedNoCharge
      ? [{
        job_id: NO_CHARGE_JOB_ID,
        readiness_revision: "ready-no-charge",
        dependency_generation: 1,
        ready: true,
        blockers: [],
      }]
      : []),
  ];
  let correctedDuringAuthoriseId: string | null = null;
  let correctedAfterBindId: string | null = null;
  let correctedDuringFinalCommitId: string | null = null;
  let injectingFinalCommitCorrection = false;
  let failNextReleaseMemberOverlapRead = false;
  let approveNewestReleaseOnOverlapFailure = false;
  const advanceNoChargeDocket = () => {
    const current = dockets.find((row) => row.id === NO_CHARGE_DOCKET_ID)!;
    dockets.push({
      ...current,
      id: CHANGED_NO_CHARGE_DOCKET_ID,
      output_content_hash:
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      committed_at: new Date().toISOString(),
    });
    currentDocketByJobId.set(
      NO_CHARGE_JOB_ID,
      CHANGED_NO_CHARGE_DOCKET_ID,
    );
  };

  const tableRows = (table: string): any[] => {
    switch (table) {
      case "makesafe_docket_revisions_current":
        return dockets.filter((row) =>
          currentDocketByJobId.get(row.job_id) === row.id
        );
      case "makesafe_docket_revisions":
        return dockets;
      case "makesafe_readiness_current_v2":
        return readinessRows;
      case "makesafe_invoice_obligation_revisions":
      case "makesafe_invoice_obligation_revisions_current":
        return [obligation, ...(mixedNoCharge ? [noChargeObligation] : [])];
      case "makesafe_docket_artifacts":
        return artifacts;
      case "job_assignments":
      case "job_service_reports":
      case "job_events":
      case "makesafe_job_details":
        return [];
      case "xero_invoices":
        return xeroRows;
      case "ses_release_operators":
        return [{ user_id: USER.id, active: true, operator_class: "captain" }];
      case "makesafe_release_revisions":
        return releases;
      case "makesafe_release_revision_members":
        return releaseMembers;
      case "makesafe_release_revision_routes":
        return releaseRoutes;
      case "makesafe_revision_approvals":
      case "makesafe_revision_approvals_current_v2":
        return approvals;
      case "ses_docket_review_current":
        return [...reviews.values()];
      case "ses_external_effects":
        return [...effects.values()];
      case "ses_release_route_proofs":
        return routeProofs;
      case "makesafe_closeout_revisions":
        return closeouts;
      default:
        return [];
    }
  };

  const matches = (
    row: any,
    eq: Record<string, any>,
    ins: Record<string, any[]>,
  ) =>
    Object.entries(eq).every(([key, value]) => row?.[key] === value) &&
    Object.entries(ins).every(([key, values]) => values.includes(row?.[key]));

  const client: any = {
    from(table: string) {
      const eq: Record<string, any> = {};
      const ins: Record<string, any[]> = {};
      let limit = Infinity;
      let mutation: { kind: "update" | "upsert"; value: any } | null = null;
      const result = () => {
        if (mutation?.kind === "upsert" && table === "xero_invoices") {
          const value = mutation.value;
          const existing = xeroRows.find((row) =>
            row.xero_invoice_id === value.xero_invoice_id
          );
          if (existing) Object.assign(existing, value);
          else xeroRows.push(value);
        }
        const rows = tableRows(table).filter((row) => matches(row, eq, ins));
        if (mutation?.kind === "update") {
          for (const row of rows) Object.assign(row, mutation.value);
        }
        return rows.slice(0, limit);
      };
      const builder: any = {
        select: () => builder,
        eq: (key: string, value: any) => {
          eq[key] = value;
          return builder;
        },
        in: (key: string, values: any[]) => {
          ins[key] = values;
          return builder;
        },
        not: () => builder,
        or: () => builder,
        order: () => builder,
        limit: (value: number) => {
          limit = value;
          return builder;
        },
        update: (value: any) => {
          mutation = { kind: "update", value };
          return builder;
        },
        upsert: (value: any) => {
          mutation = { kind: "upsert", value };
          return builder;
        },
        maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
        single: async () => ({ data: result()[0] ?? null, error: null }),
        then: (resolve: any, reject: any) => {
          if (
            table === "makesafe_release_revision_members" &&
            Array.isArray(ins.docket_revision_id) &&
            failNextReleaseMemberOverlapRead
          ) {
            failNextReleaseMemberOverlapRead = false;
            if (approveNewestReleaseOnOverlapFailure) {
              approveNewestReleaseOnOverlapFailure = false;
              const newest = releases[releases.length - 1];
              newest.state = "approved";
              const operationKey = `ses:route_send:${newest.id}:invoice`;
              effects.set(operationKey, {
                operation_key: operationKey,
                org_id: ORG_ID,
                job_id: JOB_ID,
                effect_kind: "route_send",
                release_revision_id: newest.id,
                docket_revision_id: DOCKET_ID,
                route_kind: "invoice",
                payload_hash:
                  "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
                external_token: "synthetic-concurrent-partial-token",
                state: "unknown",
              });
            }
            return Promise.resolve({
              data: null,
              error: { message: "synthetic overlap read unavailable once" },
            }).then(resolve, reject);
          }
          return Promise.resolve({ data: result(), error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return builder;
    },
    storage: {
      from: () => ({
        upload: async () => ({ data: {}, error: null }),
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://synthetic.invalid/${path}` },
          error: null,
        }),
        download: async () => ({
          data: new Blob([draftPdf.slice().buffer as ArrayBuffer]),
          error: null,
        }),
      }),
    },
    async rpc(name: string, args: any) {
      order.push(name);
      if (name === "record_ses_revision_approval_v1") {
        if (
          args.p_approval.action === "release" && failReleaseApprovalOnce
        ) {
          failReleaseApprovalOnce = false;
          return {
            data: null,
            error: { message: "synthetic release approval unavailable once" },
          };
        }
        const row = {
          id: `approval-${approvals.length + 1}`,
          decision: "approved",
          decided_at: new Date().toISOString(),
          ...args.p_approval,
        };
        approvals.push(row);
        return { data: row, error: null };
      }
      if (name === "begin_ses_invoice_execution_v1") {
        return { data: { reserved: true }, error: null };
      }
      if (name === "claim_ses_external_effect_v1") {
        const proposed = args.p_effect;
        const existing = effects.get(proposed.operation_key);
        if (existing) {
          return {
            data: {
              effect: { ...existing },
              claim_mode: existing.state === "confirmed"
                ? "confirmed"
                : "reconcile",
              duplicate_refused: true,
            },
            error: null,
          };
        }
        const row = {
          ...proposed,
          state: "reserved",
          lease_owner: args.p_lease_owner,
          lease_expires_at: new Date(Date.now() + 120_000).toISOString(),
        } as SesExternalEffect;
        effects.set(row.operation_key, row);
        return {
          data: {
            effect: { ...row },
            claim_mode: "dispatch",
            duplicate_refused: false,
          },
          error: null,
        };
      }
      if (name === "transition_ses_external_effect_v1") {
        const row = effects.get(args.p_operation_key)!;
        if (!row || row.state !== args.p_from_state) {
          return {
            data: null,
            error: { code: "40001", message: "stale effect state" },
          };
        }
        const from = row.state as SesEffectState;
        const to = args.p_to_state as SesEffectState;
        const allowed =
          (from === "reserved" && ["dispatching", "failed"].includes(to)) ||
          (from === "dispatching" &&
            ["unknown", "confirmed", "failed"].includes(to)) ||
          (from === "unknown" && ["confirmed", "failed"].includes(to)) ||
          (from === "failed" &&
            ["unknown", "confirmed", "compensated"].includes(to)) ||
          (from === "confirmed" && to === "compensated");
        if (!allowed) {
          return {
            data: null,
            error: { code: "23514", message: "invalid transition" },
          };
        }
        Object.assign(row, {
          state: to,
          external_id: args.p_detail?.external_id || row.external_id,
          provider_digest: args.p_detail?.provider_digest ||
            row.provider_digest,
        });
        return { data: { ...row }, error: null };
      }
      if (name === "commit_ses_invoice_bound_docket_v1") {
        assertEquals(
          approvals.filter((row) => row.action === "release").length,
          0,
          "the AUTHORISED bind must happen before any release approval",
        );
        const base = dockets.find((row) =>
          row.id === args.p_binding.based_on_revision_id
        )!;
        const bound = {
          ...base,
          ...args.p_binding,
          stage: "invoice_bound",
          state: "prepared",
          xero_binding: args.p_binding.xero_binding,
          committed_at: new Date().toISOString(),
        };
        dockets.push(bound);
        currentDocketByJobId.set(bound.job_id, bound.id);
        const readiness = readinessRows.find((row) =>
          row.job_id === bound.job_id
        )!;
        Object.assign(readiness, {
          readiness_revision: "ready-authorised-synthetic",
          dependency_generation: 2,
        });
        artifacts.push({
          id: "artifact-authorised",
          revision_id: bound.id,
          media_type: "application/pdf",
          ...args.p_pdf_artifact,
        });
        return { data: bound, error: null };
      }
      if (name === "record_ses_docket_review_state_v1") {
        if (args.p_event.event_kind === "signed_off" && failRatifyOnce) {
          failRatifyOnce = false;
          return {
            data: null,
            error: { message: "synthetic ratify write unavailable once" },
          };
        }
        const docket = dockets.find((row) =>
          row.id === args.p_event.docket_revision_id
        )!;
        const review = {
          docket_revision_id: docket.id,
          docket_output_content_hash: docket.output_content_hash,
          assembler_version: docket.assembler_version,
          family_matrix_version: docket.family_matrix_version,
          review_state: args.p_event.event_kind === "signed_off"
            ? "signed_off"
            : "needs_review",
        };
        reviews.set(docket.id, review);
        if (
          args.p_event.event_kind === "signed_off" &&
          prepareCorrectionAfterBind && !correctedAfterBindId
        ) {
          const current = await loadSesCockpitDocket(client, JOB_ID, {
            fetchInvoicePdfBytes: (id) => xeroGateway.fetchAuthorisedPdf(id),
          });
          const corrected = await prepareSesReleaseRevisionAction(client, {
            org_id: ORG_ID,
            job_ids: [JOB_ID],
            routes: current.routes.map((route) => ({
              ...route,
              subject: `${route.subject} — corrected after bind`,
            })),
            created_by: USER.email,
          }, {
            fetchInvoicePdfBytes: (id) => xeroGateway.fetchAuthorisedPdf(id),
            assertWorkflowReleaseContract:
              sealedWorkflowContractFixture.assertWorkflowReleaseContract,
          });
          correctedAfterBindId = String(corrected.release.id);
        }
        return { data: review, error: null };
      }
      if (name === "commit_ses_release_revision_v1") {
        const source = releases[0];
        if (
          prepareCorrectionDuringFinalCommit && xeroAuthorised && source &&
          args.p_release.id !== source.id &&
          !correctedDuringFinalCommitId && !injectingFinalCommitCorrection
        ) {
          injectingFinalCommitCorrection = true;
          try {
            const current = await loadSesCockpitDocket(client, JOB_ID, {
              fetchInvoicePdfBytes: (id) => xeroGateway.fetchAuthorisedPdf(id),
            });
            const corrected = await prepareSesReleaseRevisionAction(client, {
              org_id: ORG_ID,
              job_ids: [JOB_ID],
              routes: current.routes.map((route) => ({
                ...route,
                subject: `${route.subject} — corrected during final commit`,
              })),
              created_by: USER.email,
            }, {
              fetchInvoicePdfBytes: (id) => xeroGateway.fetchAuthorisedPdf(id),
              assertWorkflowReleaseContract:
                sealedWorkflowContractFixture.assertWorkflowReleaseContract,
            });
            correctedDuringFinalCommitId = String(corrected.release.id);
          } finally {
            injectingFinalCommitCorrection = false;
          }
        }
        let release = releases.find((row) => row.id === args.p_release.id);
        if (!release) {
          release = {
            ...args.p_release,
            state: "proposed",
            created_at: new Date(Date.now() + clock++).toISOString(),
            updated_at: new Date().toISOString(),
          };
          releases.push(release);
          args.p_members.forEach((row: any) =>
            releaseMembers.push({
              ...row,
              release_revision_id: release.id,
            })
          );
          args.p_routes.forEach((row: any) =>
            releaseRoutes.push({
              ...row,
              release_revision_id: release.id,
            })
          );
        }
        return { data: { ...release }, error: null };
      }
      if (name === "assert_ses_dockets_signed_off_v1") {
        const ok = args.p_docket_revision_ids.every((id: string) =>
          reviews.get(id)?.review_state === "signed_off"
        );
        return { data: ok ? { signed_off: true } : null, error: null };
      }
      if (name === "begin_ses_release_execution_v1") {
        const release = releases.find((row) =>
          row.id === args.p_release_revision_id
        )!;
        release.state = "dispatching";
        return { data: release, error: null };
      }
      if (name === "confirm_ses_release_route_v1") {
        const proof = {
          release_revision_id: args.p_release_revision_id,
          route_kind: args.p_route_kind,
          proof_hash: args.p_proof_hash,
          proven_at: new Date().toISOString(),
        };
        routeProofs.push(proof);
        return { data: proof, error: null };
      }
      if (name === "commit_ses_release_closeout_v1") {
        const closeout = {
          ...args.p_closeout,
          verified: true,
          verified_at: new Date().toISOString(),
        };
        closeouts.push(closeout);
        const release = releases.find((row) =>
          row.id === closeout.release_revision_id
        )!;
        release.state = "released";
        return { data: closeout, error: null };
      }
      return { data: {}, error: null };
    },
  };

  const xeroGateway: SesXeroGateway = {
    async createDraft() {
      throw new Error(
        "the already-bound real DRAFT must reconcile, never mint twice",
      );
    },
    async reconcileCreate() {
      return [xeroAuthorised ? authorisedInvoice : draftInvoice];
    },
    async authorise() {
      xeroAuthoriseDispatches++;
      if (supersedeSourceDuringAuthorise) {
        const source = releases.find((row) => row.state === "proposed")!;
        const sourceJobIds = releaseMembers
          .filter((row) => row.release_revision_id === source.id)
          .map((row) => row.job_id);
        const sourceRoutes = releaseRoutes
          .filter((row) => row.release_revision_id === source.id)
          .map((row) => ({
            route_kind: row.route_kind,
            recipients: row.recipients,
            cc: row.cc,
            subject: `${row.subject} — corrected during authorise`,
            body: row.body,
            attachment_hashes: row.attachment_hashes,
            required: row.required,
            ready: true,
          }));
        const corrected = await prepareSesReleaseRevisionAction(client, {
          org_id: ORG_ID,
          job_ids: sourceJobIds,
          routes: sourceRoutes,
          created_by: USER.email,
        }, {
          fetchInvoicePdfBytes: (id) => xeroGateway.fetchAuthorisedPdf(id),
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        });
        correctedDuringAuthoriseId = String(corrected.release.id);
      }
      xeroAuthorised = true;
      Object.assign(obligation.xero_binding, authorisedInvoice);
      Object.assign(xeroRows[0], authorisedInvoice);
      if (advanceNoChargeDuringAuthorise) advanceNoChargeDocket();
      return authorisedInvoice;
    },
    async reconcileAuthorise() {
      return xeroAuthorised ? [authorisedInvoice] : [];
    },
    async fetchAuthorisedPdf() {
      return xeroAuthorised ? authorisedPdf : draftPdf;
    },
  };
  const sentByToken = new Map<string, any>();
  const mailGateway: SesMailGateway = {
    async createDraftAndSend(_route, context) {
      sends.push(context.external_token);
      const sent = {
        message_id: `sent-${sends.length}`,
        state: "sent" as const,
        operation_token: context.external_token,
      };
      sentByToken.set(context.external_token, sent);
      return sent;
    },
    async reconcileSent(token) {
      const sent = sentByToken.get(token);
      return sent ? [sent] : [];
    },
  };
  const releaseXeroReader: SesReleaseXeroReader = {
    async readAuthorised() {
      return xeroAuthorised;
    },
  };
  return {
    client,
    xeroGateway,
    mailGateway,
    releaseXeroReader,
    order,
    sends,
    approvals,
    effects,
    releases,
    releaseRoutes,
    dockets,
    releaseMembers,
    xeroAuthoriseDispatches: () => xeroAuthoriseDispatches,
    correctedDuringAuthoriseId: () => correctedDuringAuthoriseId,
    correctedAfterBindId: () => correctedAfterBindId,
    correctedDuringFinalCommitId: () => correctedDuringFinalCommitId,
    failNextReleaseMemberOverlapRead: () => {
      failNextReleaseMemberOverlapRead = true;
    },
    approveNewestReleaseOnNextOverlapFailure: () => {
      failNextReleaseMemberOverlapRead = true;
      approveNewestReleaseOnOverlapFailure = true;
    },
    advanceNoChargeDocket,
  };
}

async function prepareMixedOptionBPreview(
  h: ReturnType<typeof optionBHarness>,
) {
  const priced = await loadSesCockpitDocket(h.client, JOB_ID, {
    fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
  });
  return await prepareSesReleaseRevisionAction(h.client, {
    org_id: ORG_ID,
    job_ids: [JOB_ID, NO_CHARGE_JOB_ID],
    routes: priced.routes,
    created_by: USER.email,
  }, {
    fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
    assertWorkflowReleaseContract:
      sealedWorkflowContractFixture.assertWorkflowReleaseContract,
  });
}

Deno.test("T11 Option B real actions: DRAFT approval authorises, binds, mints, approves, then sends", async () => {
  const h = optionBHarness();
  const preview = await prepareSesReleaseRevisionAction(h.client, {
    org_id: ORG_ID,
    job_ids: [JOB_ID],
    created_by: USER.email,
  }, {
    fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
    assertWorkflowReleaseContract:
      sealedWorkflowContractFixture.assertWorkflowReleaseContract,
  });
  const sourceId = String(preview.release.id);
  const result = await unifiedSesReleaseAction(h.client, auth, {
    org_id: ORG_ID,
    release_revision_id: sourceId,
    expected_release_content_hash: String(preview.release.content_hash),
    actor: USER.email,
  }, {
    xeroGateway: h.xeroGateway,
    mailGateway: h.mailGateway,
    releaseXeroReader: h.releaseXeroReader,
    assertWorkflowReleaseContract:
      sealedWorkflowContractFixture.assertWorkflowReleaseContract,
  });

  assertEquals(result.state, "released");
  if (result.state !== "released") throw new Error("expected released result");
  assert(result.release_revision_id !== sourceId);
  assertEquals(result.source_release_revision_id, sourceId);
  assertEquals(h.sends.length, 1);
  assertEquals(
    h.releases.find((row) => row.id === sourceId)?.state,
    "superseded",
  );
  assertEquals(
    h.releases.find((row) => row.id === result.release_revision_id)?.state,
    "released",
  );
  assertEquals(h.approvals.map((row) => row.action), ["invoice", "release"]);
  const bindIndex = h.order.indexOf("commit_ses_invoice_bound_docket_v1");
  const releaseApprovalIndex = h.order.lastIndexOf(
    "record_ses_revision_approval_v1",
  );
  assert(bindIndex >= 0 && releaseApprovalIndex > bindIndex);
});

Deno.test("unified production-default gate refuses before approval, Xero, or Graph", async () => {
  const h = optionBHarness();
  const preview = await prepareSesReleaseRevisionAction(h.client, {
    org_id: ORG_ID,
    job_ids: [JOB_ID],
    created_by: USER.email,
  }, {
    fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
    assertWorkflowReleaseContract:
      sealedWorkflowContractFixture.assertWorkflowReleaseContract,
  });
  const approvalCount = h.approvals.length;
  const error = await assertRejects(
    () =>
      unifiedSesReleaseAction(h.client, auth, {
        org_id: ORG_ID,
        release_revision_id: String(preview.release.id),
        expected_release_content_hash: String(preview.release.content_hash),
        actor: USER.email,
      }, {
        xeroGateway: h.xeroGateway,
        mailGateway: h.mailGateway,
        releaseXeroReader: h.releaseXeroReader,
      }),
    SesActionError,
  );
  assertEquals(error.status, 409);
  assertEquals(h.approvals.length, approvalCount);
  assertEquals(h.xeroAuthoriseDispatches(), 0);
  assertEquals(h.sends, []);
  assertEquals(h.order.includes("xero_authorise"), false);
  assertEquals(h.order.includes("mail_send"), false);
});

Deno.test(
  "AC6 confirmed route effect closes from ledger proof with zero provider calls",
  async () => {
    const h = optionBHarness();
    const preview = await prepareSesReleaseRevisionAction(h.client, {
      org_id: ORG_ID,
      job_ids: [JOB_ID],
      created_by: USER.email,
    }, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    const first = await unifiedSesReleaseAction(h.client, auth, {
      org_id: ORG_ID,
      release_revision_id: String(preview.release.id),
      expected_release_content_hash: String(preview.release.content_hash),
      actor: USER.email,
    }, {
      xeroGateway: h.xeroGateway,
      mailGateway: h.mailGateway,
      releaseXeroReader: h.releaseXeroReader,
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    assertEquals(first.state, "released");
    if (first.state !== "released") throw new Error("expected released result");
    assertEquals(h.sends.length, 1);

    let providerCalls = 0;
    h.mailGateway.createDraftAndSend = async () => {
      providerCalls++;
      throw new Error("confirmed effect must not open or send a Graph draft");
    };
    h.mailGateway.reconcileSent = async () => {
      providerCalls++;
      throw new Error("confirmed effect must not call mutating reconciliation");
    };

    const replay = await executeSesReleaseRevisionAction(
      h.client,
      auth,
      {
        org_id: ORG_ID,
        release_revision_id: first.release_revision_id,
        actor: USER.email,
      },
      h.mailGateway,
      h.releaseXeroReader,
      sealedWorkflowContractFixture,
    );
    assertEquals(replay.state, "released");
    assertEquals(providerCalls, 0);
    assertEquals(h.sends.length, 1);
  },
);

Deno.test(
  "T11 Option B recovery: post-authorise ratify failure resumes without second money action",
  async () => {
    const h = optionBHarness({ failRatifyOnce: true });
    const preview = await prepareSesReleaseRevisionAction(h.client, {
      org_id: ORG_ID,
      job_ids: [JOB_ID],
      created_by: USER.email,
    }, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    const sourceId = String(preview.release.id);
    await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends, []);
    assertEquals(
      h.releases.find((row) => row.id === sourceId)?.state,
      "proposed",
    );
    const recovered = await unifiedSesReleaseAction(h.client, auth, {
      org_id: ORG_ID,
      release_revision_id: sourceId,
      expected_release_content_hash: String(preview.release.content_hash),
      actor: USER.email,
    }, {
      xeroGateway: h.xeroGateway,
      mailGateway: h.mailGateway,
      releaseXeroReader: h.releaseXeroReader,
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    assertEquals(recovered.state, "released");
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends.length, 1);
  },
);

Deno.test(
  "T11 Option B recovery: final approval failure reuses the exact prepared derivative",
  async () => {
    const h = optionBHarness({ failReleaseApprovalOnce: true });
    const preview = await prepareSesReleaseRevisionAction(h.client, {
      org_id: ORG_ID,
      job_ids: [JOB_ID],
      created_by: USER.email,
    }, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    const sourceId = String(preview.release.id);
    await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    const preparedFinalIds = h.releases
      .filter((row) => row.id !== sourceId)
      .map((row) => row.id);
    assertEquals(preparedFinalIds.length, 1);
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends, []);

    const recovered = await unifiedSesReleaseAction(h.client, auth, {
      org_id: ORG_ID,
      release_revision_id: sourceId,
      expected_release_content_hash: String(preview.release.content_hash),
      actor: USER.email,
    }, {
      xeroGateway: h.xeroGateway,
      mailGateway: h.mailGateway,
      releaseXeroReader: h.releaseXeroReader,
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    assertEquals(recovered.state, "released");
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends.length, 1);
    assertEquals(
      h.releases.filter((row) => row.id !== sourceId).map((row) => row.id),
      preparedFinalIds,
    );
  },
);

Deno.test(
  "T11 Option B mixed recovery resumes only the already-prepared current derivative",
  async () => {
    const h = optionBHarness({
      mixedNoCharge: true,
      failReleaseApprovalOnce: true,
    });
    const preview = await prepareMixedOptionBPreview(h);
    const sourceId = String(preview.release.id);
    await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends, []);
    assertEquals(
      h.releases.find((row) => row.id === sourceId)?.state,
      "superseded",
    );
    const bindWritesBeforeRetry =
      h.order.filter((name) => name === "commit_ses_invoice_bound_docket_v1")
        .length;
    const reviewWritesBeforeRetry =
      h.order.filter((name) => name === "record_ses_docket_review_state_v1")
        .length;

    const recovered = await unifiedSesReleaseAction(h.client, auth, {
      org_id: ORG_ID,
      release_revision_id: sourceId,
      expected_release_content_hash: String(preview.release.content_hash),
      actor: USER.email,
    }, {
      xeroGateway: h.xeroGateway,
      mailGateway: h.mailGateway,
      releaseXeroReader: h.releaseXeroReader,
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    assertEquals(recovered.state, "released");
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends.length, 1);
    assertEquals(
      h.order.filter((name) => name === "commit_ses_invoice_bound_docket_v1")
        .length,
      bindWritesBeforeRetry,
      "superseded-source recovery must not rebind a docket",
    );
    assertEquals(
      h.order.filter((name) => name === "record_ses_docket_review_state_v1")
        .length,
      reviewWritesBeforeRetry,
      "superseded-source recovery must not write a fresh signoff",
    );
  },
);

Deno.test(
  "T11 Option B mixed recovery refuses a changed no-charge docket before send",
  async () => {
    const h = optionBHarness({
      mixedNoCharge: true,
      failReleaseApprovalOnce: true,
    });
    const preview = await prepareMixedOptionBPreview(h);
    const sourceId = String(preview.release.id);
    await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    h.advanceNoChargeDocket();

    const error = await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    assertEquals((error.refusal as any).code, "stale_review");
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends, []);
  },
);

Deno.test(
  "T11 Option B refuses no-charge drift that lands during Xero authorisation",
  async () => {
    const h = optionBHarness({
      mixedNoCharge: true,
      advanceNoChargeDuringAuthorise: true,
    });
    const preview = await prepareMixedOptionBPreview(h);
    const sourceId = String(preview.release.id);
    const error = await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    assertEquals((error.refusal as any).code, "stale_review");
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends, []);
    assertEquals(h.releases.length, 1, "no final release was committed");
  },
);

Deno.test(
  "T11 Option B refuses a corrected release minted during Xero authorisation",
  async () => {
    const h = optionBHarness({ supersedeSourceDuringAuthorise: true });
    const preview = await prepareSesReleaseRevisionAction(h.client, {
      org_id: ORG_ID,
      job_ids: [JOB_ID],
      created_by: USER.email,
    }, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    const sourceId = String(preview.release.id);
    const error = await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    const correctedId = h.correctedDuringAuthoriseId();
    assert(correctedId);
    assertEquals((error.refusal as any).code, "stale_review");
    assertEquals(
      h.releases.find((row) => row.id === sourceId)?.state,
      "superseded",
    );
    assertEquals(
      h.releases.find((row) => row.id === correctedId)?.state,
      "proposed",
    );
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends, []);
    assertEquals(h.releases.length, 2, "no stale derivative was committed");
  },
);

Deno.test(
  "T11 Option B refuses a correction prepared from the AUTHORISED child before final commit",
  async () => {
    const h = optionBHarness({ prepareCorrectionAfterBind: true });
    const preview = await prepareSesReleaseRevisionAction(h.client, {
      org_id: ORG_ID,
      job_ids: [JOB_ID],
      created_by: USER.email,
    }, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    const sourceId = String(preview.release.id);
    const error = await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    const correctedId = h.correctedAfterBindId();
    assert(correctedId);
    assertEquals((error.refusal as any).code, "stale_review");
    assertEquals(
      h.releases.find((row) => row.id === sourceId)?.state,
      "proposed",
    );
    assertEquals(
      h.releases.find((row) => row.id === correctedId)?.state,
      "proposed",
    );
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends, []);
    assertEquals(
      h.releases.length,
      2,
      "the stale derivative must not be committed",
    );
  },
);

Deno.test(
  "T11 Option B protected commit cannot retire a correction that wins the final read race",
  async () => {
    const h = optionBHarness({ prepareCorrectionDuringFinalCommit: true });
    const preview = await prepareSesReleaseRevisionAction(h.client, {
      org_id: ORG_ID,
      job_ids: [JOB_ID],
      created_by: USER.email,
    }, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    const sourceId = String(preview.release.id);
    const error = await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    const correctedId = h.correctedDuringFinalCommitId();
    assert(correctedId);
    assertEquals((error.refusal as any).code, "stale_review");
    assertEquals(
      h.releases.find((row) => row.id === correctedId)?.state,
      "proposed",
      "the independent correction remains current",
    );
    const rejectedDerivatives = h.releases.filter((row) =>
      row.id !== sourceId && row.id !== correctedId
    );
    assertEquals(rejectedDerivatives.length, 1);
    assertEquals(
      rejectedDerivatives[0].state,
      "superseded",
      "the durably committed stale candidate is retired before refusal",
    );
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends, []);
  },
);

Deno.test(
  "T11 superseded source cannot replace a later corrected current release",
  async () => {
    const h = optionBHarness({
      mixedNoCharge: true,
      failReleaseApprovalOnce: true,
    });
    const preview = await prepareMixedOptionBPreview(h);
    const sourceId = String(preview.release.id);
    await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    const current = await loadSesCockpitDocket(h.client, JOB_ID, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
    });
    const corrected = await prepareSesReleaseRevisionAction(h.client, {
      org_id: ORG_ID,
      job_ids: [JOB_ID, NO_CHARGE_JOB_ID],
      routes: current.routes.map((route) => ({
        ...route,
        subject: `${route.subject} — corrected`,
      })),
      created_by: USER.email,
    }, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    const correctedId = String(corrected.release.id);
    assertEquals(
      h.releases.find((row) => row.id === correctedId)?.state,
      "proposed",
    );

    const error = await assertRejects(
      () =>
        unifiedSesReleaseAction(h.client, auth, {
          org_id: ORG_ID,
          release_revision_id: sourceId,
          expected_release_content_hash: String(preview.release.content_hash),
          actor: USER.email,
        }, {
          xeroGateway: h.xeroGateway,
          mailGateway: h.mailGateway,
          releaseXeroReader: h.releaseXeroReader,
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    assertEquals((error.refusal as any).code, "stale_review");
    assertEquals(
      h.releases.find((row) => row.id === correctedId)?.state,
      "proposed",
    );
    assertEquals(h.xeroAuthoriseDispatches(), 1);
    assertEquals(h.sends, []);
  },
);

Deno.test("T11 Option B real actions: altered AUTHORISED artifact hard-refuses before bind or send", async () => {
  const h = optionBHarness(true);
  const preview = await prepareSesReleaseRevisionAction(h.client, {
    org_id: ORG_ID,
    job_ids: [JOB_ID],
    created_by: USER.email,
  }, {
    fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
    assertWorkflowReleaseContract:
      sealedWorkflowContractFixture.assertWorkflowReleaseContract,
  });
  const error = await assertRejects(
    () =>
      unifiedSesReleaseAction(h.client, auth, {
        org_id: ORG_ID,
        release_revision_id: String(preview.release.id),
        expected_release_content_hash: String(preview.release.content_hash),
        actor: USER.email,
      }, {
        xeroGateway: h.xeroGateway,
        mailGateway: h.mailGateway,
        releaseXeroReader: h.releaseXeroReader,
        assertWorkflowReleaseContract:
          sealedWorkflowContractFixture.assertWorkflowReleaseContract,
      }),
    SesActionError,
  );
  assertEquals(
    ((error as SesActionError).refusal as { code?: string }).code,
    "authorised_derivative_mismatch",
  );
  assertEquals(h.sends, []);
  assertEquals(h.order.includes("commit_ses_invoice_bound_docket_v1"), false);
  assertEquals(h.approvals.map((row) => row.action), ["invoice"]);
});

Deno.test(
  "AC6 idempotent commit never retires an existing approved partial release after an overlap read failure",
  async () => {
    const h = optionBHarness();
    const preview = await prepareSesReleaseRevisionAction(h.client, {
      org_id: ORG_ID,
      job_ids: [JOB_ID],
      created_by: USER.email,
    }, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    const releaseId = String(preview.release.id);
    const existing = h.releases.find((row) => row.id === releaseId)!;
    existing.state = "approved";
    const operationKey = `ses:route_send:${releaseId}:invoice`;
    h.effects.set(operationKey, {
      operation_key: operationKey,
      org_id: ORG_ID,
      job_id: JOB_ID,
      effect_kind: "route_send",
      release_revision_id: releaseId,
      docket_revision_id: DOCKET_ID,
      route_kind: "invoice",
      payload_hash:
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      external_token: "synthetic-partial-release-token",
      state: "unknown",
    });
    h.failNextReleaseMemberOverlapRead();

    const error = await assertRejects(
      () => commitSesReleaseRevisionPlanAction(h.client, preview),
      SesActionError,
    );
    assertEquals(error.status, 503);
    assertEquals(existing.state, "approved");
    assertEquals(h.effects.get(operationKey)?.state, "unknown");
    assertEquals(h.releases.length, 1);
    assertEquals(h.sends, []);
    await assertSesReleaseRevisionIsCurrent(h.client, releaseId);
  },
);

Deno.test(
  "AC6 compensation cannot retire an exact release approved after the RPC snapshot",
  async () => {
    const h = optionBHarness();
    const preview = await prepareSesReleaseRevisionAction(h.client, {
      org_id: ORG_ID,
      job_ids: [JOB_ID],
      created_by: USER.email,
    }, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    const releaseId = String(preview.release.id);
    h.releases.splice(0);
    h.releaseMembers.splice(0);
    h.releaseRoutes.splice(0);
    h.approveNewestReleaseOnNextOverlapFailure();

    const error = await assertRejects(
      () => commitSesReleaseRevisionPlanAction(h.client, preview),
      SesActionError,
    );
    const concurrent = h.releases.find((row) => row.id === releaseId)!;
    const effect = [...h.effects.values()].find((row) =>
      row.release_revision_id === releaseId
    );
    assertEquals(error.status, 503);
    assertEquals(concurrent.state, "approved");
    assertEquals(effect?.state, "unknown");
    assertEquals(h.releases.length, 1);
    assertEquals(h.sends, []);
    await assertSesReleaseRevisionIsCurrent(h.client, releaseId);
  },
);

Deno.test("AC7 real actions: minting corrected release B supersedes approved A and A hard-refuses", async () => {
  const h = optionBHarness();
  const preview = await prepareSesReleaseRevisionAction(h.client, {
    org_id: ORG_ID,
    job_ids: [JOB_ID],
    created_by: USER.email,
  }, {
    fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
    assertWorkflowReleaseContract:
      sealedWorkflowContractFixture.assertWorkflowReleaseContract,
  });
  const deps = createSupabaseUnifiedReleaseDeps(h.client, auth, {
    org_id: ORG_ID,
    actor: USER.email,
    xeroGateway: h.xeroGateway,
    mailGateway: h.mailGateway,
    releaseXeroReader: h.releaseXeroReader,
    assertWorkflowReleaseContract:
      sealedWorkflowContractFixture.assertWorkflowReleaseContract,
  });
  const source = await deps.loadRelease(String(preview.release.id));
  assert(source);
  const materialized = await deps.materializeAuthorisedDerivative!(source);
  const approvedA = materialized.release;
  assertEquals(approvedA.state, "approved");
  const routeA = h.releaseRoutes.find((row) =>
    row.release_revision_id === approvedA.release_revision_id
  );
  assert(routeA);
  const correctedB = await prepareSesReleaseRevisionAction(h.client, {
    org_id: ORG_ID,
    job_ids: [JOB_ID],
    routes: [{
      route_kind: routeA.route_kind,
      recipients: routeA.recipients,
      cc: routeA.cc,
      subject: `${routeA.subject} - corrected`,
      body: routeA.body,
      attachment_hashes: routeA.attachment_hashes,
      ready: true,
    }],
    created_by: USER.email,
  }, sealedWorkflowContractFixture);
  assert(String(correctedB.release.id) !== approvedA.release_revision_id);
  assertEquals(
    h.releases.find((row) => row.id === approvedA.release_revision_id)?.state,
    "superseded",
  );

  const error = await assertRejects(
    () =>
      unifiedSesReleaseAction(h.client, auth, {
        org_id: ORG_ID,
        release_revision_id: approvedA.release_revision_id,
        expected_release_content_hash: approvedA.content_hash,
        actor: USER.email,
      }, {
        xeroGateway: h.xeroGateway,
        mailGateway: h.mailGateway,
        releaseXeroReader: h.releaseXeroReader,
        assertWorkflowReleaseContract:
          sealedWorkflowContractFixture.assertWorkflowReleaseContract,
      }),
    SesActionError,
  );
  assertEquals(
    ((error as SesActionError).refusal as { code?: string }).code,
    "stale_review",
  );
  assertEquals(h.sends, []);
});

Deno.test(
  "AC6 real ledger: a correction attempt cannot strand or replace a partial release",
  async () => {
    const h = optionBHarness();
    const releaseA = await prepareSesReleaseRevisionAction(h.client, {
      org_id: ORG_ID,
      job_ids: [JOB_ID],
      created_by: USER.email,
    }, {
      fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
      assertWorkflowReleaseContract:
        sealedWorkflowContractFixture.assertWorkflowReleaseContract,
    });
    const releaseAId = String(releaseA.release.id);
    const releaseARow = h.releases.find((row) => row.id === releaseAId)!;
    releaseARow.state = "approved";
    h.effects.set("partial-route-effect", {
      id: "effect-partial-a",
      operation_key: "ses:route_send:partial-a",
      org_id: ORG_ID,
      effect_kind: "route_send",
      release_revision_id: releaseAId,
      route_kind: "invoice",
      payload_hash: "sha256:partial-a",
      external_token: "SES-PARTIAL-A",
      state: "confirmed",
    });
    const correctedRoutes = releaseA.routes.map((route: any) => ({
      ...route,
      subject: `${route.subject} - corrected`,
      ready: true,
    }));
    const refusal = await assertRejects(
      () =>
        prepareSesReleaseRevisionAction(h.client, {
          org_id: ORG_ID,
          job_ids: [JOB_ID],
          routes: correctedRoutes,
          created_by: USER.email,
        }, {
          fetchInvoicePdfBytes: (id) => h.xeroGateway.fetchAuthorisedPdf(id),
          assertWorkflowReleaseContract:
            sealedWorkflowContractFixture.assertWorkflowReleaseContract,
        }),
      SesActionError,
    );
    assertEquals(
      ((refusal as SesActionError).refusal as { code?: string }).code,
      "release_in_flight",
    );
    const releaseB = h.releases.find((row) => row.id !== releaseAId)!;
    assertEquals(releaseARow.state, "approved");
    assertEquals(releaseB.state, "superseded");
    await assertSesReleaseRevisionIsCurrent(h.client, releaseAId);
    const staleB = await assertRejects(
      () => assertSesReleaseRevisionIsCurrent(h.client, releaseB.id),
      SesActionError,
    );
    assertEquals(
      ((staleB as SesActionError).refusal as { code?: string }).code,
      "stale_review",
    );
  },
);
