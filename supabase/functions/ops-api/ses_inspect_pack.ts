/**
 * T12 (Harden SES v1, trace T12 / AC2): ONE shared inspect read.
 *
 * Both front doors (website cockpit and terminal/MCP) must show IDENTICAL truth
 * about a reviewable pack. Before this action each door composed four separate
 * feeds — `makesafe_pipeline` (pack pointer ids), `query_ses_review_cockpit`
 * (current docket revision + hash), `get_ses_reviewable_pack` (docket/audit),
 * and `job_detail` (documents) — and could assemble slightly different views.
 * This action composes the SAME canonical readers server-side and returns one
 * unified object: the main pack pointer ids, the exact current docket revision
 * id + output/content hash + invoice obligation revision, the frozen release
 * manifest identity (recipients / subject / attachment identities) when a
 * release revision exists, the delivery proofs, and the approval/audit state.
 *
 * It is READ-ONLY. It REUSES `loadSesCockpitDocket` (the reader the cockpit door
 * itself uses) for the docket coordinates + xero binding + release-send
 * progress, and thin direct reads for the pack pointers, the frozen release
 * manifest, the route proofs, and the approval ledger. It never recomputes a
 * stage, never writes, and never touches money/send/approval.
 */
import type { SesSupabaseClient } from "./ses_reporting_actions.ts";
import {
  loadSesCockpitDocket,
  SesActionError,
} from "./ses_reporting_actions.ts";
import type {
  SesCockpitDocket,
  SesReleaseSendProgress,
} from "./ses_review_cockpit.ts";

/** Main-pack pointer ids and send lifecycle facts. */
export interface SesPackPointers {
  exists: boolean;
  status: string | null;
  report_doc_id: string | null;
  invoice_doc_id: string | null;
  swms_doc_id: string | null;
  sent_at: string | null;
  send_started_at: string | null;
}

/** Exact current docket review coordinates a caller echoes back at APPROVE. */
export interface SesInspectDocketCoordinates {
  docket_revision_id: string;
  output_content_hash: string | null;
  invoice_obligation_revision_id: string | null;
  readiness_revision: string;
  dependency_generation: number;
}

/**
 * The invoice facts a door needs to make an approve/send decision: the pack
 * pointer, the Xero identity (number / status / total), and the builder-facing
 * reference. `pack.invoice_doc_id` is the bound document; `xero_invoice_id` +
 * `status` are the live money. No door should have to compose these from a
 * separate mirror read.
 */
export interface SesInspectInvoice {
  doc_id: string | null;
  xero_invoice_id: string | null;
  number: string | null;
  status: string | null;
  total: number | null;
  reference: string | null;
  pdf_available: boolean;
}

/**
 * Proposed send recipe from the CURRENT docket (recipients / cc / subject /
 * attachment count per route). This is the pre-freeze recipe the operator sees
 * before a release revision is prepared; once a release exists the frozen
 * manifest (`release.routes`, hashed) is the authority.
 */
export interface SesInspectRecipeRoute {
  route_kind: string;
  recipients: string[];
  cc: string[];
  subject: string;
  attachment_count: number;
  ready: boolean;
}

/** Frozen release manifest identity (never the raw body — body_hash is identity). */
export interface SesInspectReleaseManifest {
  release_revision_id: string;
  content_hash: string;
  state: string;
  members: Array<{
    job_id: string;
    docket_revision_id: string;
    invoice_obligation_revision_id: string | null;
    ordinal: number;
  }>;
  routes: Array<{
    route_kind: string;
    ordinal: number;
    required: boolean;
    recipients: string[];
    cc: string[];
    subject: string;
    body_hash: string;
    attachment_hashes: string[];
    envelope_hash: string;
  }>;
}

export interface SesInspectRouteProof {
  route_kind: string;
  proof_hash: string;
  proven_at: string | null;
  external_message_id: string | null;
}

export interface SesInspectApproval {
  action: string;
  decision: string;
  docket_revision_id: string | null;
  invoice_obligation_revision_id: string | null;
  release_revision_id: string | null;
  approval_content_hash: string | null;
  includes_authorise: boolean;
  decided_by: string | null;
  decided_at: string | null;
}

export interface SesPackInspection {
  schema: "secureworks.makesafe.ses-pack-inspection/v1";
  job_id: string;
  job_number: string | null;
  pack: SesPackPointers;
  docket: SesInspectDocketCoordinates;
  xero_binding: SesCockpitDocket["xero_binding"];
  invoice: SesInspectInvoice;
  send_recipe: SesInspectRecipeRoute[];
  release: SesInspectReleaseManifest | null;
  release_send_progress: SesReleaseSendProgress;
  route_proofs: SesInspectRouteProof[];
  approvals: SesInspectApproval[];
}

function str(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((v) => String(v ?? "")).filter((v) => v.length > 0)
    : [];
}

/**
 * PURE assembler: builds the unified inspection from already-read rows. Kept
 * pure so both doors' identical-truth contract can be unit-tested without a
 * database. The reader (`inspectSesPackAction`) supplies the rows.
 */
export function assembleSesPackInspection(input: {
  job_id: string;
  job_number: string | null;
  docket: SesInspectDocketCoordinates;
  xero_binding: SesCockpitDocket["xero_binding"];
  xero_invoice_pdf_available?: boolean;
  local_invoice_proposal: Record<string, unknown> | null;
  docket_routes: Array<Record<string, unknown>>;
  release_send_progress: SesReleaseSendProgress;
  pack_row: Record<string, unknown> | null;
  release_row: Record<string, unknown> | null;
  member_rows: Array<Record<string, unknown>>;
  route_rows: Array<Record<string, unknown>>;
  proof_rows: Array<Record<string, unknown>>;
  approval_rows: Array<Record<string, unknown>>;
}): SesPackInspection {
  const pack: SesPackPointers = input.pack_row
    ? {
      exists: true,
      status: str(input.pack_row.status),
      report_doc_id: str(input.pack_row.report_doc_id),
      invoice_doc_id: str(input.pack_row.invoice_doc_id),
      swms_doc_id: str(input.pack_row.swms_doc_id),
      sent_at: str(input.pack_row.sent_at),
      send_started_at: str(input.pack_row.send_started_at),
    }
    : {
      exists: false,
      status: null,
      report_doc_id: null,
      invoice_doc_id: null,
      swms_doc_id: null,
      sent_at: null,
      send_started_at: null,
    };

  const proposal = input.local_invoice_proposal ?? {};
  const proposalTotal = Number(
    (proposal as Record<string, unknown>).total_inc_gst ??
      (proposal as Record<string, unknown>).total ??
      (proposal as Record<string, unknown>).subtotal_ex_gst,
  );
  const invoice: SesInspectInvoice = {
    doc_id: pack.invoice_doc_id,
    xero_invoice_id: str(input.xero_binding?.xero_invoice_id),
    number: str(input.xero_binding?.invoice_number),
    status: str(input.xero_binding?.status),
    total: input.xero_binding?.total != null &&
        Number.isFinite(Number(input.xero_binding.total))
      ? Number(input.xero_binding.total)
      : (Number.isFinite(proposalTotal) ? proposalTotal : null),
    reference: str((proposal as Record<string, unknown>).reference),
    pdf_available: input.xero_invoice_pdf_available === true,
  };

  const send_recipe: SesInspectRecipeRoute[] = input.docket_routes.map((
    row,
  ) => ({
    route_kind: String(row.route_kind ?? ""),
    recipients: stringArray(row.recipients),
    cc: stringArray(row.cc),
    subject: String(row.subject ?? ""),
    attachment_count: stringArray(row.attachment_hashes).length,
    ready: row.ready === true,
  }));

  let release: SesInspectReleaseManifest | null = null;
  if (input.release_row) {
    release = {
      release_revision_id: String(input.release_row.id ?? ""),
      content_hash: String(input.release_row.content_hash ?? ""),
      state: String(input.release_row.state ?? ""),
      members: [...input.member_rows]
        .sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0))
        .map((row) => ({
          job_id: String(row.job_id ?? ""),
          docket_revision_id: String(row.docket_revision_id ?? ""),
          invoice_obligation_revision_id: str(
            row.invoice_obligation_revision_id,
          ),
          ordinal: Number(row.ordinal ?? 0),
        })),
      routes: [...input.route_rows]
        .sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0))
        .map((row) => ({
          route_kind: String(row.route_kind ?? ""),
          ordinal: Number(row.ordinal ?? 0),
          required: row.required !== false,
          recipients: stringArray(row.recipients),
          cc: stringArray(row.cc),
          subject: String(row.subject ?? ""),
          body_hash: String(row.body_hash ?? ""),
          attachment_hashes: stringArray(row.attachment_hashes),
          envelope_hash: String(row.envelope_hash ?? ""),
        })),
    };
  }

  const route_proofs: SesInspectRouteProof[] = input.proof_rows.map((row) => ({
    route_kind: String(row.route_kind ?? ""),
    proof_hash: String(row.proof_hash ?? ""),
    proven_at: str(row.proven_at),
    external_message_id: str(row.external_message_id),
  }));

  const approvals: SesInspectApproval[] = input.approval_rows.map((row) => ({
    action: String(row.action ?? ""),
    decision: String(row.decision ?? ""),
    docket_revision_id: str(row.docket_revision_id),
    invoice_obligation_revision_id: str(row.invoice_obligation_revision_id),
    release_revision_id: str(row.release_revision_id),
    approval_content_hash: str(row.approval_content_hash),
    includes_authorise: row.includes_authorise === true,
    decided_by: str(row.decided_by),
    decided_at: str(row.decided_at),
  }));

  return {
    schema: "secureworks.makesafe.ses-pack-inspection/v1",
    job_id: input.job_id,
    job_number: input.job_number,
    pack,
    docket: input.docket,
    xero_binding: input.xero_binding,
    invoice,
    send_recipe,
    release,
    release_send_progress: input.release_send_progress,
    route_proofs,
    approvals,
  };
}

export interface InspectSesPackDeps {
  fetchInvoicePdfBytes?: (invoiceId: string) => Promise<Uint8Array>;
  /**
   * The docket reader, defaulting to the canonical `loadSesCockpitDocket` so the
   * inspect door and the cockpit door read the same coordinates. Injectable so
   * the assembly + reader wiring can be exercised without the full cockpit read
   * surface.
   */
  loadDocket?: (
    client: SesSupabaseClient,
    jobId: string,
    deps: { fetchInvoicePdfBytes?: (invoiceId: string) => Promise<Uint8Array> },
  ) => Promise<SesCockpitDocket>;
}

export async function inspectSesPackAction(
  client: SesSupabaseClient,
  jobId: string,
  releaseRevisionIdOverride?: string | null,
  deps: InspectSesPackDeps = {},
): Promise<SesPackInspection> {
  if (!jobId) {
    throw new SesActionError(400, {
      state: "refused",
      fact: "job_id required",
    });
  }
  const loadDocket = deps.loadDocket ?? loadSesCockpitDocket;
  const docket = await loadDocket(client, jobId, {
    fetchInvoicePdfBytes: deps.fetchInvoicePdfBytes,
  });

  const packRead = await client.from("makesafe_report_packs")
    .select(
      "id,pack_kind,status,report_doc_id,invoice_doc_id,swms_doc_id,sent_at,send_started_at",
    )
    .eq("job_id", jobId).eq("pack_kind", "main").maybeSingle();
  if (packRead.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The pack pointers could not be read (${
        packRead.error.message || "unknown database error"
      }).`,
    });
  }

  const releaseRevisionId = str(releaseRevisionIdOverride) ??
    (docket.release_send_progress &&
        docket.release_send_progress.kind !== "none"
      ? str(docket.release_send_progress.release_revision_id)
      : null);

  let releaseRow: Record<string, unknown> | null = null;
  let memberRows: Array<Record<string, unknown>> = [];
  let routeRows: Array<Record<string, unknown>> = [];
  let proofRows: Array<Record<string, unknown>> = [];
  if (releaseRevisionId) {
    const [releaseResp, membersResp, routesResp, proofsResp] = await Promise
      .all(
        [
          client.from("makesafe_release_revisions")
            .select("id,content_hash,state,created_at,updated_at")
            .eq("id", releaseRevisionId).maybeSingle(),
          client.from("makesafe_release_revision_members")
            .select(
              "job_id,docket_revision_id,invoice_obligation_revision_id,ordinal",
            )
            .eq("release_revision_id", releaseRevisionId).order("ordinal"),
          client.from("makesafe_release_revision_routes")
            .select(
              "route_kind,ordinal,required,recipients,cc,subject,body_hash,attachment_hashes,envelope_hash",
            )
            .eq("release_revision_id", releaseRevisionId).order("ordinal"),
          client.from("ses_release_route_proofs")
            .select("route_kind,proof_hash,proven_at,external_message_id")
            .eq("release_revision_id", releaseRevisionId),
        ],
      );
    if (
      releaseResp.error || membersResp.error || routesResp.error ||
      proofsResp.error
    ) {
      throw new SesActionError(503, {
        state: "refused",
        fact: `The frozen release manifest could not be read (${
          releaseResp.error?.message || membersResp.error?.message ||
          routesResp.error?.message || proofsResp.error?.message ||
          "unknown database error"
        }).`,
      });
    }
    releaseRow = releaseResp.data || null;
    memberRows = membersResp.data || [];
    routeRows = routesResp.data || [];
    proofRows = proofsResp.data || [];
  }

  const approvalsResp = await client.from(
    "makesafe_revision_approvals_current_v2",
  ).select(
    "action,decision,docket_revision_id,invoice_obligation_revision_id,release_revision_id,approval_content_hash,includes_authorise,decided_by,decided_at",
  ).eq("job_id", jobId).order("decided_at", { ascending: false });
  if (approvalsResp.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The approval ledger could not be read (${
        approvalsResp.error.message || "unknown database error"
      }).`,
    });
  }

  return assembleSesPackInspection({
    job_id: jobId,
    job_number: docket.job_number,
    docket: {
      docket_revision_id: docket.docket_revision_id,
      output_content_hash: docket.docket_output_content_hash ?? null,
      invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
      readiness_revision: docket.readiness_revision,
      dependency_generation: docket.dependency_generation,
    },
    xero_binding: docket.xero_binding,
    xero_invoice_pdf_available: docket.xero_invoice_pdf_available === true,
    local_invoice_proposal: docket.local_invoice_proposal ?? null,
    docket_routes: (docket.routes ?? []) as unknown as Array<
      Record<string, unknown>
    >,
    release_send_progress: docket.release_send_progress ?? { kind: "none" },
    pack_row: packRead.data || null,
    release_row: releaseRow,
    member_rows: memberRows,
    route_rows: routeRows,
    proof_rows: proofRows,
    approval_rows: approvalsResp.data || [],
  });
}
