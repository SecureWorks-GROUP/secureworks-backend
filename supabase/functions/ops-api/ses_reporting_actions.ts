// deno-lint-ignore-file no-explicit-any
import { normRef, splitEmails } from "./makesafe_send_pack.ts";
import {
  prepareSesInvoiceObligation,
  SES_PRICING_CANON_VERSION,
  type SesInvoiceProposalV1,
  type SesPricingDisposition,
} from "./makesafe_invoice_obligation.ts";
import {
  resolveSesInvoiceDuplicates,
  type SesInvoiceDuplicateRequest,
  type SesInvoiceIndexRow,
} from "./makesafe_invoice_duplicate_resolver.ts";
import {
  buildSesEffect,
  executeSesExternalEffect,
  type SesExternalAdapter,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import {
  buildSesCockpitView,
  buildSesReleaseRevision,
  canRecordSesApproval,
  evaluateSesMechanicalClean,
  SES_ROUTE_ORDER,
  type SesApprovalAuth,
  type SesCleanInput,
  type SesCockpitDocket,
  type SesReviewRoute,
} from "./ses_review_cockpit.ts";
import { sesSha256, stableUuidFromSha256 } from "./ses_docket_envelope.ts";
import {
  canManageSesDocsReadySignoff,
  nextSesDocsReadyState,
} from "./ses_docs_ready.ts";
import { SES_DOCKET_BUCKET } from "./ses_docket_persistence.ts";
import {
  isSesRefusal,
  type SesRefusal,
  sesRefusal,
} from "./ses_reporting_refusals.ts";

interface SupabaseResponse<T> {
  data: T | null;
  error: { message?: string } | null;
}

export interface SesSupabaseClient {
  from(table: string): any;
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<SupabaseResponse<any>>;
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        bytes: Uint8Array,
        options: { contentType: string; upsert: false },
      ): Promise<SupabaseResponse<any>>;
      createSignedUrl(
        path: string,
        expiresIn: number,
      ): Promise<SupabaseResponse<{ signedUrl: string }>>;
    };
  };
}

export interface SesActionAuth {
  mode: "api_key" | "jwt" | "routine";
  user: {
    id: string;
    email: string;
    role: string;
  } | null;
}

export class SesActionError extends Error {
  constructor(
    public status: number,
    public refusal: SesRefusal | { state: "refused"; fact: string },
  ) {
    super(refusal.fact);
  }
}

function requireValue(
  response: SupabaseResponse<any>,
  fact: string,
): any {
  if (response.error || !response.data) {
    throw new SesActionError(409, {
      state: "refused",
      fact: `${fact} ${
        response.error?.message ? `(${response.error.message})` : ""
      }`.trim(),
    });
  }
  return response.data;
}

function object(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function parseDraft(
  routeKind: "report" | "photo" | "invoice",
  value: unknown,
): SesReviewRoute | null {
  const text = String(value || "").trim();
  if (!text) return null;
  const header = (name: string): string => {
    const match = text.match(new RegExp(`^${name}:\\s*(.*)$`, "mi"));
    return match?.[1]?.trim() || "";
  };
  const recipients = splitEmails(header("To"));
  const cc = splitEmails(header("Cc"));
  const subject = header("Subject");
  const attachments = header("Attachments").split(",").map((item) =>
    item.trim()
  ).filter(Boolean);
  const body = text.replace(/^(?:To|Cc|Subject|Attachments):.*$/gmi, "")
    .trim();
  return {
    route_kind: routeKind,
    recipients,
    cc,
    subject,
    body,
    attachment_hashes: attachments,
    ready: !!subject && !!body && recipients.length > 0,
  };
}

function refusalFromStored(value: unknown): SesRefusal {
  const row = object(value);
  const fact = String(
    row.fact || row.reason ||
      "The current readiness row does not record which real-world fact is missing.",
  );
  return {
    state: "refused",
    code: String(row.code || row.reason_code || "readiness_fact_missing"),
    fact,
    recovery_action: String(
      row.recovery_action ||
        "Resolve the named real-world fact and prepare a new docket revision.",
    ),
    ...(row.decision_key ? { decision_key: String(row.decision_key) } : {}),
  };
}

function draftRoutes(docket: Record<string, any>): SesReviewRoute[] {
  const drafts = object(docket.email_drafts);
  const candidates: Array<[typeof SES_ROUTE_ORDER[number], unknown]> = [
    ["report", drafts.REPORT_EMAIL_DRAFT],
    ["photo", drafts.PHOTO_EMAIL_DRAFT],
    ["invoice", drafts.INVOICE_EMAIL_DRAFT],
  ];
  return candidates.map(([kind, value]) => parseDraft(kind, value)).filter((
    value,
  ): value is SesReviewRoute => !!value);
}

function resolveDocketRoutes(
  docket: Record<string, any>,
  artifacts: Array<Record<string, any>>,
  obligation: Record<string, any> | null,
): SesReviewRoute[] {
  const byPath = new Map<string, Record<string, any>>();
  for (const artifact of artifacts) {
    const key = String(artifact.object_key || "");
    const marker = `/${docket.id}/`;
    const path = key.includes(marker)
      ? key.slice(key.indexOf(marker) + marker.length)
      : key.split("/").slice(-2).join("/");
    byPath.set(path, artifact);
  }
  const invoicePdf = artifacts.find((artifact) =>
    artifact.role === "xero_invoice_pdf"
  );
  const noAdditionalCharge =
    obligation?.pricing_disposition === "no_additional_charge";
  return draftRoutes(docket).map((route) => {
    const resolved = route.attachment_hashes.map((path) => byPath.get(path))
      .filter((artifact): artifact is Record<string, any> => !!artifact)
      .map((artifact) => String(artifact.content_hash));
    if (route.route_kind === "invoice" && noAdditionalCharge) {
      const proposalArtifact = artifacts.find((artifact) =>
        artifact.role === "invoice_proposal"
      );
      const nonInvoiceProposalAttachments = resolved.filter((hash) =>
        hash !== proposalArtifact?.content_hash
      );
      const reference = String(
        object(docket.local_invoice_proposal).builder_reference || "",
      );
      return {
        ...route,
        subject: `${reference || "Make-safe"} - no additional charge`,
        body:
          "This later attendance is recorded as document only with no additional charge. The current report and photo evidence are supplied through the accompanying approved routes.",
        attachment_hashes: nonInvoiceProposalAttachments,
        ready: route.ready &&
          resolved.length === route.attachment_hashes.length,
      };
    }
    if (route.route_kind !== "invoice" || docket.stage !== "invoice_bound") {
      return {
        ...route,
        attachment_hashes: resolved,
        ready: route.ready &&
          resolved.length === route.attachment_hashes.length,
      };
    }
    const xero = object(docket.xero_binding);
    const proposalArtifact = artifacts.find((artifact) =>
      artifact.role === "invoice_proposal"
    );
    const invoiceAttachments = resolved.filter((hash) =>
      hash !== proposalArtifact?.content_hash
    );
    if (invoicePdf?.content_hash) {
      invoiceAttachments.unshift(String(invoicePdf.content_hash));
    }
    const reference = String(
      object(docket.local_invoice_proposal).builder_reference || "",
    );
    const invoiceNumber = String(xero.invoice_number || "");
    return {
      ...route,
      subject: `${reference || "Make-safe"} - Xero invoice ${invoiceNumber}`
        .trim(),
      body:
        "Please find the authorised SecureWorks Xero invoice and the supporting current-cycle documents attached.",
      attachment_hashes: [...new Set(invoiceAttachments)],
      ready: route.ready && !!invoicePdf?.content_hash &&
        xero.status === "AUTHORISED",
    };
  });
}

function cleanInputFromRows(args: {
  docket: Record<string, any>;
  readiness: Record<string, any>;
  obligation: Record<string, any> | null;
  routes: SesReviewRoute[];
}): SesCleanInput {
  const envelope = object(args.docket.envelope);
  const manifest = object(envelope.v2);
  const classification = object(manifest.classification);
  const review = object(args.docket.review_spec);
  const cards = Array.isArray(review.cards) ? review.cards : [];
  const card = object(cards[0]);
  const portalProof = Array.isArray(card.portal_proof) ? card.portal_proof : [];
  const portalStatus =
    portalProof.some((proof) => object(proof).status === "unreachable")
      ? "unreachable"
      : (portalProof.some((proof) => object(proof).status === "not_done")
        ? "not_done"
        : (portalProof.length ? "done" : "not_applicable"));
  const items = object(manifest.items);
  const blockers = Array.isArray(args.readiness.blockers)
    ? args.readiness.blockers.map(refusalFromStored)
    : [];
  const storedBlockers = Array.isArray(args.docket.blockers)
    ? args.docket.blockers.map(refusalFromStored)
    : [];
  const obligationBlockers = Array.isArray(args.obligation?.blockers)
    ? args.obligation.blockers.map(refusalFromStored)
    : [];
  const family = String(card.family || classification.family || "");
  const physical = family === "physical_makesafe" ||
    family === "temporary_fencing";
  const pricingDisposition = String(
    args.obligation?.pricing_disposition || "money_review_required",
  ) as SesPricingDisposition;
  const duplicate = object(args.obligation?.duplicate_probe);
  return {
    pre_xero_docs_ready: args.docket.pre_xero_docs_ready === true,
    readiness_ready: args.readiness.ready === true,
    readiness_blockers: [
      ...blockers,
      ...storedBlockers,
      ...obligationBlockers,
    ],
    pricing_disposition: pricingDisposition,
    line_overrides_audited: pricingDisposition !==
        "priced_with_line_override" ||
      (Array.isArray(args.obligation?.proposal?.lines) &&
        args.obligation.proposal.lines.every((line: any) =>
          line.rate_override_approved && line.rate_override_by &&
          line.rate_override_at
        )),
    duplicate_allows_create: duplicate.allows_create === true,
    invoice_already_bound: args.docket.stage === "invoice_bound" &&
      object(args.docket.xero_binding).status === "AUTHORISED",
    duplicate_ambiguity: String(duplicate.ambiguity || "none"),
    money_blocker_codes: [
      ...blockers,
      ...storedBlockers,
      ...obligationBlockers,
    ].map((blocker) => blocker.code),
    post_release_disposition_outstanding: [
      "blocked_billing_disposition",
      "billing_disposition_required",
    ].includes(pricingDisposition),
    family,
    family_matrix_version: String(args.docket.family_matrix_version || "") ||
      null,
    assessment_recipe_version: classification
        .assessment_outbound_recipe_version
      ? String(classification.assessment_outbound_recipe_version)
      : null,
    portal_required: portalProof.length > 0,
    portal_capture_status: portalStatus,
    own_document_exemption: classification.report_delivery === "own_document",
    physical_media_complete: !physical ||
      object(items.physical_reporting_evidence).state === "ready",
    completed_work_photo_proven: !physical ||
      object(items.physical_reporting_evidence).state === "ready",
    obligation_revision_count: args.obligation ? 1 : 0,
    routes: args.routes,
    type_check_hold: storedBlockers.some((blocker) =>
      blocker.code === "type_check"
    ),
    story_unverified: storedBlockers.some((blocker) =>
      blocker.code === "story_unverified"
    ),
    trade_report_submitted: !physical ||
      object(items.physical_reporting_evidence).state === "ready",
    roof_report_required: family === "own_template_roof",
    roof_report_filled: family !== "own_template_roof" ||
      object(items.supporting_report_pdf).state === "ready",
    report_only: classification.report_only === true,
  };
}

export async function loadSesCockpitDocket(
  client: SesSupabaseClient,
  jobId: string,
): Promise<SesCockpitDocket> {
  const docketResponse = await client.from("makesafe_docket_revisions_current")
    .select("*").eq("job_id", jobId).maybeSingle();
  const docket = requireValue(
    docketResponse,
    "No current SES docket revision exists for this job.",
  );
  const readinessResponse = await client.from("makesafe_readiness_current_v2")
    .select("*").eq("job_id", jobId).maybeSingle();
  const readiness = requireValue(
    readinessResponse,
    "No current readiness revision exists for this job.",
  );
  const obligationResponse = docket.invoice_obligation_revision_id
    ? await client.from("makesafe_invoice_obligation_revisions")
      .select("*").eq("id", docket.invoice_obligation_revision_id).maybeSingle()
    : await client.from("makesafe_invoice_obligation_revisions_current")
      .select("*").eq("job_id", jobId).order("created_at", { ascending: false })
      .limit(1).maybeSingle();
  if (obligationResponse.error) {
    throw new SesActionError(409, {
      state: "refused",
      fact: `The current invoice obligation could not be read (${
        obligationResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const obligation = obligationResponse.data || null;
  const artifactsResponse = await client.from("makesafe_docket_artifacts")
    .select("role,object_key,media_type,content_hash,size_bytes,metadata")
    .eq("revision_id", docket.id)
    .order("object_key");
  if (artifactsResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The current docket attachments could not be read (${
        artifactsResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const [assignmentsResponse, reportsResponse] = await Promise.all([
    client.from("job_assignments")
      .select(
        "id,job_id,user_id,scheduled_date,status,role,crew_name,travel_started_at,arrived_at,started_at,clocked_on_at,completed_at,attendance_cycle_id,cycle_attribution,users:user_id(id,name,phone)",
      )
      .eq("job_id", jobId)
      .order("scheduled_date", { ascending: true }),
    client.from("job_service_reports")
      .select(
        "id,job_id,submitted_by,status,submitted_at,created_at,cycle_number,attendance_cycle_id,cycle_attribution,checklist_json,notes,signature_name,weather,start_time,end_time,variations",
      )
      .eq("job_id", jobId)
      .order("created_at", { ascending: true }),
  ]);
  if (assignmentsResponse.error || reportsResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The crew and raw trade visit history could not be read (${
        assignmentsResponse.error?.message ||
        reportsResponse.error?.message ||
        "unknown database error"
      }).`,
    });
  }
  const routes = resolveDocketRoutes(
    docket,
    artifactsResponse.data || [],
    obligation,
  );
  const cleanInput = cleanInputFromRows({
    docket,
    readiness,
    obligation,
    routes,
  });
  const manifest = object(object(docket.envelope).v2);
  return {
    job_id: jobId,
    job_number: object(manifest.classification).job_number || null,
    docket_revision_id: docket.id,
    readiness_revision: readiness.readiness_revision,
    dependency_generation: Number(readiness.dependency_generation),
    invoice_obligation_revision_id: obligation?.id || null,
    attendance_cycle_ids: docket.attendance_cycle_ids || [],
    xero_binding: docket.xero_binding || obligation?.xero_binding || null,
    local_invoice_proposal: obligation?.proposal ||
      docket.local_invoice_proposal || null,
    work_order: object(manifest.items).source_work_order_attachment || null,
    family_evidence: object(manifest.items),
    swms: object(manifest.items).swms_current_cycle || {},
    routes,
    crew_and_trade_visits: {
      assignments: assignmentsResponse.data || [],
      visit_reports: reportsResponse.data || [],
    },
    clean_input: cleanInput,
  };
}

export async function querySesReviewCockpitAction(
  client: SesSupabaseClient,
  jobId: string,
  displayedBinding?: {
    readiness_revision: string;
    dependency_generation: number;
  },
  releaseRevisionId?: string,
) {
  const cockpit = buildSesCockpitView(
    await loadSesCockpitDocket(client, jobId),
    displayedBinding,
  );
  if (!releaseRevisionId) return cockpit;
  const [releaseResponse, membersResponse, routesResponse] = await Promise.all([
    client.from("makesafe_release_revisions").select("*")
      .eq("id", releaseRevisionId).maybeSingle(),
    client.from("makesafe_release_revision_members").select("*")
      .eq("release_revision_id", releaseRevisionId).order("ordinal"),
    client.from("makesafe_release_revision_routes").select("*")
      .eq("release_revision_id", releaseRevisionId).order("ordinal"),
  ]);
  const release = requireValue(
    releaseResponse,
    "The displayed composite release revision no longer exists.",
  );
  const members = membersResponse.data || [];
  const routes = routesResponse.data || [];
  if (
    membersResponse.error || routesResponse.error ||
    !members.some((member: any) => member.job_id === jobId) ||
    routes.length !== 3
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The displayed composite release does not contain this job and all three exact email routes.",
    });
  }
  return {
    ...cockpit,
    release_revision: {
      id: release.id,
      content_hash: release.content_hash,
      state: release.state,
      readiness_bindings: release.readiness_bindings,
      members,
      routes,
    },
  };
}

async function loadIndexedInvoiceRows(
  client: SesSupabaseClient,
  orgId: string,
  requests: SesInvoiceDuplicateRequest[],
): Promise<SesInvoiceIndexRow[]> {
  const jobs = [...new Set(requests.map((request) => request.job_id))];
  const refs = [
    ...new Set(
      requests.map((request) => normRef(request.external_ref)).filter((value) =>
        value.length >= 5
      ),
    ),
  ];
  const columns =
    "id,job_id,xero_invoice_id,invoice_number,status,reference,reference_normalized,invoice_type,invoice_obligation_revision_id";
  const byJob = await client.from("xero_invoices").select(columns)
    .eq("org_id", orgId).in("job_id", jobs);
  if (byJob.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The indexed Xero mirror could not be checked by job (${
        byJob.error.message || "unknown database error"
      }).`,
    });
  }
  const referenceRows: SesInvoiceIndexRow[] = [];
  for (const ref of refs) {
    const byReference = await client.from("xero_invoices").select(columns)
      .eq("org_id", orgId)
      .eq("invoice_type", "ACCREC")
      .not("status", "in", '("VOIDED","DELETED")')
      .or(`reference_normalized.eq.${ref},reference_normalized.like.*${ref}*`)
      .limit(25);
    if (byReference.error) {
      throw new SesActionError(503, {
        state: "refused",
        fact:
          `The indexed Xero mirror could not be checked by builder reference (${
            byReference.error.message || "unknown database error"
          }).`,
      });
    }
    referenceRows.push(...(byReference.data || []));
  }
  return [...(byJob.data || []), ...referenceRows];
}

export async function resolveSesInvoiceDuplicatesAction(
  client: SesSupabaseClient,
  orgId: string,
  requests: SesInvoiceDuplicateRequest[],
) {
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 50) {
    throw new TypeError("requests must contain 1..50 invoice duplicate probes");
  }
  const rows = await loadIndexedInvoiceRows(client, orgId, requests);
  return {
    results: resolveSesInvoiceDuplicates(requests, rows),
    query_shape: "indexed_job_then_normalized_reference",
    scanned_full_estate: false,
  };
}

export async function prepareSesInvoiceObligationAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    job_id: string;
    docket_revision_id?: string;
    post_release_disposition?: string | null;
    created_by: string;
  },
) {
  if (
    args.post_release_disposition &&
    (auth.mode !== "jwt" || !auth.user)
  ) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "The later attendance has no identified human disposition; an operator must choose second invoice, combine/credit review, document only, or hold pricing.",
    });
  }
  const docketQuery = client.from("makesafe_docket_revisions")
    .select("*").eq("job_id", args.job_id);
  const docketResponse = args.docket_revision_id
    ? await docketQuery.eq("id", args.docket_revision_id).maybeSingle()
    : await docketQuery.order("committed_at", { ascending: false }).limit(1)
      .maybeSingle();
  const docket = requireValue(
    docketResponse,
    "No U4 pre-Xero docket exists for this invoice proposal.",
  );
  if (docket.stage !== "pre_xero" || !docket.local_invoice_proposal) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The current docket is not a pre-Xero proposal that can mint an invoice obligation.",
    });
  }
  const manifest = object(object(docket.envelope).v2);
  const company = String(object(manifest.routing).builder || "").trim();
  if (!company) {
    throw new SesActionError(
      409,
      sesRefusal(
        "pricing_evidence_missing",
        "Recover the classified builder company from the source work order before preparing an invoice.",
        {
          fact:
            "The U4 docket has no classified builder company, so the Xero contact and pricing schedule are not proven.",
        },
      ),
    );
  }
  const existingResponse = await client.from(
    "makesafe_invoice_obligation_revisions_current",
  ).select("*").eq("job_id", args.job_id)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (existingResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The current invoice obligation could not be read (${
        existingResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const existing = existingResponse.data || null;
  if (
    existing &&
    ["create_executed", "authorised"].includes(existing.state)
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "This work already has a Xero-bound invoice that has not been released; use or compensate that exact invoice instead of proposing another one.",
    });
  }
  const local = object(docket.local_invoice_proposal);
  const reference = String(local.builder_reference || "");
  const [duplicate] = (await resolveSesInvoiceDuplicatesAction(
    client,
    args.org_id,
    [{
      job_id: args.job_id,
      external_ref: reference,
      obligation_revision_id: existing?.id || null,
    }],
  )).results;
  const existingIsCommerciallyBound = !!existing &&
    ["create_executed", "authorised", "released"].includes(existing.state);
  const explicitSecondInvoice = existingIsCommerciallyBound &&
    args.post_release_disposition === "second_invoice";
  const explicitDocumentOnly = existingIsCommerciallyBound &&
    args.post_release_disposition === "document_only";
  const currentCycleId = String(docket.current_attendance_cycle_id || "");
  const currentCycleWasAlreadyCovered = explicitSecondInvoice &&
    (existing.attendance_cycle_ids || []).includes(currentCycleId);
  const oldBoundInvoiceOnly = duplicate.live_invoices.length > 0 &&
    duplicate.live_invoices.every((invoice: SesInvoiceIndexRow) =>
      invoice.invoice_obligation_revision_id === existing?.id
    );
  const effectiveDuplicate = explicitSecondInvoice &&
      currentCycleId &&
      !currentCycleWasAlreadyCovered &&
      oldBoundInvoiceOnly &&
      duplicate.ambiguity !== "multi_live"
    ? {
      ...duplicate,
      allows_create: true,
      live_invoices: [],
      reason_codes: [
        ...duplicate.reason_codes,
        "prior_released_cycle_does_not_block_explicit_second_invoice",
      ],
    }
    : duplicate;
  const lines = Array.isArray(local.line_items)
    ? local.line_items.map((line: any) => ({
      description: String(line.description || ""),
      quantity: Number(line.quantity),
      unit_price: Number(line.unit_price_ex_gst),
      account_code: "210",
      evidence: {
        source: "u4-local-invoice-proposal",
        docket_revision_id: docket.id,
        attendance_cycle_ids: docket.attendance_cycle_ids,
      },
    }))
    : [];
  const prepared = await prepareSesInvoiceObligation({
    org_id: args.org_id,
    job_id: args.job_id,
    docket_revision_id: docket.id,
    attendance_cycle_ids: existing?.state === "released" && currentCycleId
      ? [currentCycleId]
      : docket.attendance_cycle_ids,
    pricing_disposition: explicitDocumentOnly
      ? "no_additional_charge"
      : (existingIsCommerciallyBound &&
          ["combine_credit", "hold_pricing"].includes(
            String(args.post_release_disposition || ""),
          )
        ? "money_review_required"
        : (existingIsCommerciallyBound && !args.post_release_disposition
          ? "blocked_billing_disposition"
          : (effectiveDuplicate.allows_create
            ? "priced_from_canon"
            : "blocked_duplicate_live"))),
    pricing_canon_version: SES_PRICING_CANON_VERSION,
    company,
    reference,
    contact_name: company,
    lines: explicitDocumentOnly ? [] : lines,
    guard_result: {
      hard_failures: [],
      warnings: [],
    },
    duplicate_probe: effectiveDuplicate,
    created_by: args.created_by,
    existing: existing
      ? {
        obligation_id: existing.obligation_id,
        revision_id: existing.id,
        state: existing.state,
        released_cycle_ids: existing.attendance_cycle_ids,
      }
      : null,
    post_release_disposition: args.post_release_disposition as any,
  });
  const committed = await client.rpc(
    "commit_ses_invoice_obligation_revision_v1",
    {
      p_obligation: prepared.obligation,
      p_revision: prepared.revision,
    },
  );
  return {
    ...prepared,
    commit: requireValue(
      committed,
      "The invoice obligation revision could not be committed.",
    ),
    external_mutations: { xero: 0, email: 0 },
  };
}

export function createSupabaseSesEffectStore(
  client: SesSupabaseClient,
): SesExternalEffectStore {
  return {
    async claim(effect, leaseOwner) {
      return requireValue(
        await client.rpc("claim_ses_external_effect_v1", {
          p_effect: effect,
          p_lease_owner: leaseOwner,
          p_lease_seconds: 120,
        }),
        "The exact external-effect reservation could not be claimed.",
      );
    },
    async transition(operationKey, from, to, eventKind, detail, actor) {
      return requireValue(
        await client.rpc("transition_ses_external_effect_v1", {
          p_operation_key: operationKey,
          p_from_state: from,
          p_to_state: to,
          p_event_kind: eventKind,
          p_detail: detail,
          p_actor: actor,
        }),
        "The exact external-effect ledger could not record its next state.",
      );
    },
  };
}

async function loadOperatorAuth(
  client: SesSupabaseClient,
  auth: SesActionAuth,
): Promise<SesApprovalAuth> {
  if (auth.mode === "api_key" || auth.mode === "routine") {
    return { mode: auth.mode };
  }
  if (!auth.user) {
    throw new SesActionError(401, {
      state: "refused",
      fact: "The identified SES operator session is missing.",
    });
  }
  const operator = await client.from("ses_release_operators")
    .select("operator_class").eq("user_id", auth.user.id).eq("active", true)
    .maybeSingle();
  if (operator.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The SES operator allowlist could not be read (${
        operator.error.message || "unknown database error"
      }).`,
    });
  }
  return {
    mode: "jwt",
    user_id: auth.user.id,
    role: auth.user.role,
    operator_class: operator.data?.operator_class || null,
  };
}

async function requireSesDocsReadyViewer(
  client: SesSupabaseClient,
  auth: SesActionAuth,
) {
  if (auth.mode === "api_key") return;
  const operator = await loadOperatorAuth(client, auth);
  if (
    !canManageSesDocsReadySignoff({
      mode: operator.mode,
      role: operator.mode === "jwt" ? operator.role : null,
      operator_class: operator.mode === "jwt" ? operator.operator_class : null,
    })
  ) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "The Docs Ready review pack is restricted to the Captain, an admin-owner, or the privileged ops key.",
    });
  }
}

async function requireSesDocsReadySigner(
  client: SesSupabaseClient,
  auth: SesActionAuth,
) {
  const operator = await loadOperatorAuth(client, auth);
  if (
    operator.mode !== "jwt" || !auth.user ||
    !canManageSesDocsReadySignoff({
      mode: operator.mode,
      role: operator.role,
      operator_class: operator.operator_class,
    })
  ) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "Docs Ready signoff requires an identified Captain or admin-owner session; API and automation keys cannot tick or revoke it.",
    });
  }
  return operator;
}

export async function listSesDocsReadyReviewsAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  limit = 50,
) {
  await requireSesDocsReadyViewer(client, auth);
  const safeLimit = Number.isSafeInteger(limit)
    ? Math.max(1, Math.min(limit, 100))
    : 50;
  const response = await client.from("ses_docket_review_current").select(
    "org_id,job_id,docket_revision_id,docket_output_content_hash,assembler_version,family_matrix_version,docket_stage,docket_committed_at,review_event_id,review_event_sequence,review_state,event_kind,review_state_changed_at,invalidated_signoff_event_id",
  ).eq("review_state", "needs_review")
    .order("review_state_changed_at", { ascending: true })
    .limit(safeLimit);
  if (response.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The Docs Ready review queue could not be read (${
        response.error.message || "unknown database error"
      }).`,
    });
  }
  return {
    state: "needs_review",
    dockets: response.data || [],
  };
}

export async function getSesReviewablePackAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  docketRevisionId: string,
) {
  await requireSesDocsReadyViewer(client, auth);
  if (!docketRevisionId) {
    throw new SesActionError(400, {
      state: "refused",
      fact: "docket_revision_id is required.",
    });
  }
  const review = requireValue(
    await client.from("ses_docket_review_current").select("*")
      .eq("docket_revision_id", docketRevisionId).maybeSingle(),
    "The requested docket is no longer the current reviewable pack.",
  );
  const docket = requireValue(
    await client.from("makesafe_docket_revisions").select(
      "id,org_id,job_id,output_content_hash,assembler_version,family_matrix_version,stage,committed_at,envelope,blockers,email_drafts,review_spec,local_invoice_proposal,xero_binding,artifact_count,artifact_size_bytes",
    ).eq("id", docketRevisionId).maybeSingle(),
    "The exact reviewable docket revision no longer exists.",
  );
  if (
    review.docket_output_content_hash !== docket.output_content_hash ||
    review.assembler_version !== docket.assembler_version ||
    review.family_matrix_version !== docket.family_matrix_version
  ) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Reload the current Docs Ready queue and open the exact current pack.",
      ),
    );
  }
  const artifactsResponse = await client.from("makesafe_docket_artifacts")
    .select("role,object_key,media_type,content_hash,size_bytes,metadata")
    .eq("revision_id", docketRevisionId)
    .order("object_key");
  if (artifactsResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The reviewable pack artifacts could not be read (${
        artifactsResponse.error.message || "unknown database error"
      }).`,
    });
  }
  const artifacts = await Promise.all(
    (artifactsResponse.data || []).map(async (artifact: any) => {
      const prefix = `${SES_DOCKET_BUCKET}/`;
      const objectKey = String(artifact.object_key || "");
      if (!objectKey.startsWith(prefix)) {
        throw new SesActionError(503, {
          state: "refused",
          fact:
            "A reviewable pack artifact points outside the private SES docket bucket.",
        });
      }
      const signed = await client.storage.from(SES_DOCKET_BUCKET)
        .createSignedUrl(objectKey.slice(prefix.length), 300);
      if (signed.error || !signed.data?.signedUrl) {
        throw new SesActionError(503, {
          state: "refused",
          fact: `A reviewable pack artifact URL could not be signed (${
            signed.error?.message || objectKey
          }).`,
        });
      }
      return {
        ...artifact,
        signed_url: signed.data.signedUrl,
        signed_url_expires_in_seconds: 300,
      };
    }),
  );
  const historyResponse = await client.from("ses_docket_review_events").select(
    "id,event_sequence,review_state,event_kind,actor_user_id,actor_identity,reason,signed_off_at,created_at,docket_output_content_hash,assembler_version,family_matrix_version,invalidated_signoff_event_id",
  ).eq("docket_revision_id", docketRevisionId)
    .order("event_sequence", { ascending: true });
  if (historyResponse.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The review audit trail could not be read (${
        historyResponse.error.message || "unknown database error"
      }).`,
    });
  }
  return {
    review,
    docket,
    artifacts,
    audit_trail: historyResponse.data || [],
  };
}

export async function signOffSesDocketAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    docket_revision_id: string;
    expected_output_content_hash: string;
  },
) {
  await requireSesDocsReadySigner(client, auth);
  if (
    !String(args.docket_revision_id || "").trim() ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(args.expected_output_content_hash || ""),
    )
  ) {
    throw new SesActionError(400, {
      state: "refused",
      fact:
        "docket_revision_id and the exact displayed SHA-256 output hash are required.",
    });
  }
  const current = requireValue(
    await client.from("ses_docket_review_current").select(
      "docket_revision_id,docket_output_content_hash,review_state",
    ).eq("docket_revision_id", args.docket_revision_id).maybeSingle(),
    "The requested docket is no longer the current reviewable pack.",
  );
  if (
    current.docket_output_content_hash !==
      args.expected_output_content_hash
  ) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Reload the current review pack and tick its exact displayed hash.",
      ),
    );
  }
  if (current.review_state !== "signed_off") {
    nextSesDocsReadyState(current.review_state, "signed_off");
  }
  const recorded = await client.rpc("record_ses_docket_review_state_v1", {
    p_event: {
      docket_revision_id: args.docket_revision_id,
      event_kind: "signed_off",
      expected_output_content_hash: args.expected_output_content_hash,
      actor_user_id: auth.user!.id,
      actor_identity: auth.user!.email || auth.user!.id,
      reason: "Captain approved the exact displayed pack bytes.",
    },
  });
  return {
    review: requireValue(
      recorded,
      "The exact Docs Ready signoff could not be recorded.",
    ),
  };
}

export async function revokeSesDocketSignoffAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    docket_revision_id: string;
    expected_output_content_hash: string;
    reason: string;
  },
) {
  await requireSesDocsReadySigner(client, auth);
  if (
    !String(args.docket_revision_id || "").trim() ||
    !/^sha256:[0-9a-f]{64}$/.test(
      String(args.expected_output_content_hash || ""),
    )
  ) {
    throw new SesActionError(400, {
      state: "refused",
      fact:
        "docket_revision_id and the exact displayed SHA-256 output hash are required.",
    });
  }
  if (!String(args.reason || "").trim()) {
    throw new SesActionError(400, {
      state: "refused",
      fact: "A concrete signoff revocation reason is required.",
    });
  }
  const current = requireValue(
    await client.from("ses_docket_review_current").select(
      "docket_revision_id,docket_output_content_hash,review_state",
    ).eq("docket_revision_id", args.docket_revision_id).maybeSingle(),
    "The requested docket is no longer the current reviewable pack.",
  );
  if (
    current.docket_output_content_hash !==
      args.expected_output_content_hash
  ) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Reload the current review pack before revoking its exact signoff.",
      ),
    );
  }
  nextSesDocsReadyState(current.review_state, "revoked");
  const recorded = await client.rpc("record_ses_docket_review_state_v1", {
    p_event: {
      docket_revision_id: args.docket_revision_id,
      event_kind: "revoked",
      expected_output_content_hash: args.expected_output_content_hash,
      actor_user_id: auth.user!.id,
      actor_identity: auth.user!.email || auth.user!.id,
      reason: args.reason.trim(),
    },
  });
  return {
    review: requireValue(
      recorded,
      "The exact Docs Ready signoff revocation could not be recorded.",
    ),
  };
}

export async function approveSesInvoiceRevisionAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    job_id: string;
    includes_authorise: boolean;
    evidence_refs?: unknown[];
  },
) {
  const docket = await loadSesCockpitDocket(client, args.job_id);
  if (
    docket.clean_input.pricing_disposition === "no_additional_charge"
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "This later attendance is explicitly no additional charge, so there is no Xero invoice action to approve; review the document-only routes and use SEND IT.",
    });
  }
  const verdict = evaluateSesMechanicalClean(docket.clean_input);
  const operatorAuth = await loadOperatorAuth(client, auth);
  const authority = canRecordSesApproval(operatorAuth, verdict);
  if (!authority.allowed || operatorAuth.mode !== "jwt" || !auth.user) {
    throw new SesActionError(403, {
      state: "refused",
      fact: authority.refusal ||
        "This identified operator cannot approve the current invoice revision.",
    });
  }
  const cockpit = buildSesCockpitView(docket);
  if (
    !cockpit.controls.approve_invoice.enabled && !authority.captain_override
  ) {
    const blocker = verdict.blockers[0] ||
      sesRefusal(
        "invoice_approval_missing",
        "Resolve the current cockpit hold and review a fresh invoice revision.",
        {
          fact:
            "No current executable invoice obligation revision is bound to this cockpit.",
        },
      );
    throw new SesActionError(409, blocker);
  }
  const contentHash = await sesSha256({
    action: "invoice",
    docket_revision_id: docket.docket_revision_id,
    invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
    readiness_revision: docket.readiness_revision,
    dependency_generation: docket.dependency_generation,
    includes_authorise: args.includes_authorise,
  }, "SecureWorks:ses-approval-content:v1\n");
  const approved = await client.rpc("record_ses_revision_approval_v1", {
    p_approval: {
      org_id: args.org_id,
      job_id: args.job_id,
      action: "invoice",
      operator_id: auth.user.id,
      is_admin_owner: ["admin", "owner"].includes(auth.user.role),
      clean: verdict.clean,
      captain_override: authority.captain_override,
      readiness_revision: docket.readiness_revision,
      dependency_generation: docket.dependency_generation,
      docket_revision_id: docket.docket_revision_id,
      invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
      approval_content_hash: contentHash,
      includes_authorise: args.includes_authorise,
      decided_by: auth.user.email || auth.user.id,
      evidence_refs: args.evidence_refs || [],
    },
  });
  return {
    approval: requireValue(
      approved,
      "The invoice approval could not be recorded.",
    ),
    controls: {
      approve_invoice: "recorded",
      send_it: "not_recorded",
    },
  };
}

export interface SesXeroInvoiceResult {
  xero_invoice_id: string;
  invoice_number: string;
  status: string;
  reference: string;
  total: number;
}

export interface SesXeroGateway {
  createDraft(
    proposal: SesInvoiceProposalV1,
    context: { external_token: string; operation_key: string },
  ): Promise<SesXeroInvoiceResult>;
  reconcileCreate(
    externalToken: string,
  ): Promise<SesXeroInvoiceResult[]>;
  authorise(
    invoice: SesXeroInvoiceResult,
    context: { external_token: string; operation_key: string },
  ): Promise<SesXeroInvoiceResult>;
  reconcileAuthorise(
    invoiceId: string,
  ): Promise<SesXeroInvoiceResult[]>;
  fetchAuthorisedPdf(invoiceId: string): Promise<Uint8Array>;
}

async function currentInvoiceApproval(
  client: SesSupabaseClient,
  obligationRevisionId: string,
): Promise<Record<string, any>> {
  const response = await client.from("makesafe_revision_approvals_current_v2")
    .select("*").eq("action", "invoice")
    .eq("invoice_obligation_revision_id", obligationRevisionId)
    .order("decided_at", { ascending: false }).limit(1).maybeSingle();
  if (response.error || !response.data) {
    throw new SesActionError(
      409,
      sesRefusal(
        "invoice_approval_missing",
        "Open the current cockpit and press APPROVE INVOICE for this exact revision.",
      ),
    );
  }
  return response.data;
}

async function persistSesInvoiceMirror(
  client: SesSupabaseClient,
  args: {
    org_id: string;
    job_id: string;
    invoice_obligation_revision_id: string;
    external_token: string;
    invoice: SesXeroInvoiceResult;
  },
) {
  const result = await client.from("xero_invoices").upsert({
    org_id: args.org_id,
    xero_invoice_id: args.invoice.xero_invoice_id,
    invoice_number: args.invoice.invoice_number,
    invoice_type: "ACCREC",
    status: args.invoice.status,
    reference: args.invoice.reference,
    total: args.invoice.total,
    job_id: args.job_id,
    invoice_obligation_revision_id: args.invoice_obligation_revision_id,
    ses_external_token: args.external_token,
    synced_at: new Date().toISOString(),
  }, {
    onConflict: "org_id,xero_invoice_id",
  }).select("id").maybeSingle();
  requireValue(
    result,
    "The exact Xero invoice exists, but its job, obligation revision, and SES token mirror could not be stored; reconcile that invoice before resuming.",
  );
}

export async function executeSesInvoiceRevisionAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    job_id: string;
    invoice_obligation_revision_id: string;
    actor: string;
  },
  gateway: SesXeroGateway,
) {
  if (auth.mode === "routine") {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "The make-safe automation key cannot execute an approved Xero invoice.",
    });
  }
  const revision = requireValue(
    await client.from("makesafe_invoice_obligation_revisions").select("*")
      .eq("id", args.invoice_obligation_revision_id)
      .eq("job_id", args.job_id).maybeSingle(),
    "The approved invoice obligation revision no longer exists.",
  );
  if (revision.pricing_disposition === "no_additional_charge") {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "This obligation is explicitly no additional charge, so no Xero invoice may be created; release only the approved document routes.",
    });
  }
  if (
    revision.state === "blocked" ||
    !["priced_from_canon", "priced_with_line_override"].includes(
      revision.pricing_disposition,
    )
  ) {
    const blocker = Array.isArray(revision.blockers) &&
        revision.blockers.length > 0
      ? refusalFromStored(revision.blockers[0])
      : sesRefusal(
        "pricing_evidence_missing",
        "Prepare a new invoice obligation revision with real trade evidence and an executable priced line set.",
        {
          fact:
            "The current invoice obligation has no executable priced line set.",
        },
      );
    throw new SesActionError(409, blocker);
  }
  const approval = await currentInvoiceApproval(client, revision.id);
  const cockpit = await loadSesCockpitDocket(client, args.job_id);
  if (
    cockpit.readiness_revision !== approval.readiness_revision ||
    cockpit.dependency_generation !==
      Number(approval.dependency_generation) ||
    cockpit.docket_revision_id !== approval.docket_revision_id
  ) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Review the newest docket revision and record a fresh APPROVE INVOICE decision.",
      ),
    );
  }
  const approvalContentHash = await sesSha256({
    action: "invoice",
    docket_revision_id: cockpit.docket_revision_id,
    invoice_obligation_revision_id: cockpit.invoice_obligation_revision_id,
    readiness_revision: cockpit.readiness_revision,
    dependency_generation: cockpit.dependency_generation,
    includes_authorise: approval.includes_authorise === true,
  }, "SecureWorks:ses-approval-content:v1\n");
  if (approval.approval_content_hash !== approvalContentHash) {
    throw new SesActionError(
      409,
      sesRefusal(
        "stale_review",
        "Review the exact current invoice action and record a fresh APPROVE INVOICE decision.",
      ),
    );
  }
  requireValue(
    await client.rpc("begin_ses_invoice_execution_v1", {
      p_job_id: args.job_id,
      p_invoice_obligation_revision_id: revision.id,
      p_approval_content_hash: approvalContentHash,
    }),
    "The current readiness and invoice approval could not be reserved for execution.",
  );

  const rows = await loadIndexedInvoiceRows(client, args.org_id, [{
    job_id: args.job_id,
    external_ref: revision.proposal.reference,
    obligation_revision_id: revision.id,
  }]);
  const [duplicate] = resolveSesInvoiceDuplicates([{
    job_id: args.job_id,
    external_ref: revision.proposal.reference,
    obligation_revision_id: revision.id,
  }], rows);
  if (
    !duplicate.allows_create &&
    duplicate.match_tier !== "obligation_binding"
  ) {
    throw new SesActionError(
      409,
      duplicate.ambiguity === "multi_live"
        ? sesRefusal(
          "invoice_duplicate_ambiguous",
          "Resolve which Xero invoice owns this work before execution.",
        )
        : sesRefusal(
          "invoice_duplicate_live",
          "Use the live invoice already bound to this work; no second invoice can be created.",
        ),
    );
  }

  const proposal = revision.proposal as SesInvoiceProposalV1;
  const store = createSupabaseSesEffectStore(client);
  const createEffect = await buildSesEffect({
    org_id: args.org_id,
    job_id: args.job_id,
    effect_kind: "invoice_create",
    invoice_obligation_revision_id: revision.id,
    payload: proposal,
  });
  const createAdapter: SesExternalAdapter<
    SesInvoiceProposalV1,
    SesXeroInvoiceResult
  > = {
    dispatch: (payload, context) => gateway.createDraft(payload, context),
    reconcile: (context) => gateway.reconcileCreate(context.external_token),
    identify: (result) => result.xero_invoice_id,
    digest: (result) => ({
      invoice_number: result.invoice_number,
      status: result.status,
      reference: result.reference,
      total: result.total,
    }),
  };
  const created = await executeSesExternalEffect({
    store,
    effect: createEffect,
    payload: proposal,
    adapter: createAdapter,
    actor: args.actor,
  });
  if (created.state !== "confirmed") {
    throw new SesActionError(409, created.refusal!);
  }
  const createdInvoice = created.result ||
    await gateway.reconcileCreate(createEffect.external_token).then((rows) =>
      rows[0]
    );
  if (!createdInvoice) {
    throw new SesActionError(
      409,
      sesRefusal(
        "xero_outcome_unknown",
        "Reconcile Xero by the exact SES token before resuming.",
      ),
    );
  }
  await persistSesInvoiceMirror(client, {
    org_id: args.org_id,
    job_id: args.job_id,
    invoice_obligation_revision_id: revision.id,
    external_token: createEffect.external_token,
    invoice: createdInvoice,
  });
  if (!["authorised", "released"].includes(revision.state)) {
    const bindingUpdate = await client.from(
      "makesafe_invoice_obligation_revisions",
    ).update({
      state: "create_executed",
      xero_binding: {
        xero_invoice_id: createdInvoice.xero_invoice_id,
        invoice_number: createdInvoice.invoice_number,
        status: createdInvoice.status,
        bound_at: new Date().toISOString(),
      },
    }).eq("id", revision.id).in("state", [
      "proposed",
      "pending_approval",
      "create_approved",
      "create_executed",
    ]).select("id").maybeSingle();
    requireValue(
      bindingUpdate,
      "The exact Xero draft exists under its SES token, but its invoice obligation binding could not be stored; reconcile that draft before resuming.",
    );
  }

  if (!approval.includes_authorise) {
    return {
      state: "xero_draft_created",
      invoice: createdInvoice,
      invoice_create_dispatched: created.dispatched,
      send_dispatched: false,
    };
  }
  const authorisePayload = {
    xero_invoice_id: createdInvoice.xero_invoice_id,
    expected_status: "AUTHORISED",
  };
  const authoriseEffect = await buildSesEffect({
    org_id: args.org_id,
    job_id: args.job_id,
    effect_kind: "invoice_authorise",
    invoice_obligation_revision_id: revision.id,
    payload: authorisePayload,
  });
  const authoriseAdapter: SesExternalAdapter<
    typeof authorisePayload,
    SesXeroInvoiceResult
  > = {
    dispatch: (_payload, context) => gateway.authorise(createdInvoice, context),
    reconcile: () => gateway.reconcileAuthorise(createdInvoice.xero_invoice_id),
    identify: (result) => result.xero_invoice_id,
    digest: (result) => ({
      invoice_number: result.invoice_number,
      status: result.status,
      reference: result.reference,
      total: result.total,
    }),
  };
  const authorised = await executeSesExternalEffect({
    store,
    effect: authoriseEffect,
    payload: authorisePayload,
    adapter: authoriseAdapter,
    actor: args.actor,
  });
  if (authorised.state !== "confirmed") {
    throw new SesActionError(409, authorised.refusal!);
  }
  const authorisedInvoice = authorised.result ||
    await gateway.reconcileAuthorise(createdInvoice.xero_invoice_id).then((
      rows,
    ) => rows[0]);
  if (!authorisedInvoice || authorisedInvoice.status !== "AUTHORISED") {
    throw new SesActionError(
      409,
      sesRefusal(
        "xero_not_authorised",
        "Authorise the exact bound invoice under the approved money action, then resume.",
      ),
    );
  }
  await persistSesInvoiceMirror(client, {
    org_id: args.org_id,
    job_id: args.job_id,
    invoice_obligation_revision_id: revision.id,
    external_token: createEffect.external_token,
    invoice: authorisedInvoice,
  });
  const pdf = await gateway.fetchAuthorisedPdf(
    authorisedInvoice.xero_invoice_id,
  );
  const pdfHash = await sesSha256(
    Array.from(pdf),
    "SecureWorks:ses-docket-artifact-bytes:v1\n",
  );
  const docketHash = await sesSha256({
    based_on_revision_id: cockpit.docket_revision_id,
    invoice_obligation_revision_id: revision.id,
    xero_invoice_id: authorisedInvoice.xero_invoice_id,
    pdf_content_hash: pdfHash,
  }, "SecureWorks:ses-invoice-bound-docket:v1\n");
  const boundDocketId = stableUuidFromSha256(docketHash);
  const storagePath =
    `${args.job_id}/${boundDocketId}/ARTIFACTS/Xero Invoice - ${authorisedInvoice.invoice_number}.pdf`;
  const upload = await client.storage.from("makesafe-docket-artifacts").upload(
    storagePath,
    pdf,
    { contentType: "application/pdf", upsert: false },
  );
  if (
    upload.error && !String(upload.error.message || "").toLowerCase().includes(
      "already",
    )
  ) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The real AUTHORISED Xero PDF could not be stored (${
        upload.error.message || "unknown storage error"
      }).`,
    });
  }
  const bound = await client.rpc("commit_ses_invoice_bound_docket_v1", {
    p_binding: {
      id: boundDocketId,
      job_id: args.job_id,
      based_on_revision_id: cockpit.docket_revision_id,
      invoice_obligation_revision_id: revision.id,
      output_content_hash: docketHash,
      xero_binding: {
        xero_invoice_id: authorisedInvoice.xero_invoice_id,
        invoice_number: authorisedInvoice.invoice_number,
        status: authorisedInvoice.status,
        bound_at: new Date().toISOString(),
      },
      created_by: args.actor,
    },
    p_pdf_artifact: {
      role: "xero_invoice_pdf",
      object_key: `makesafe-docket-artifacts/${storagePath}`,
      content_hash: pdfHash,
      size_bytes: pdf.byteLength,
      metadata: {
        invoice_number: authorisedInvoice.invoice_number,
        xero_invoice_id: authorisedInvoice.xero_invoice_id,
      },
    },
  });
  const boundDocket = requireValue(
    bound,
    "The real AUTHORISED Xero PDF could not be bound to a new docket revision.",
  );
  requireValue(
    await client.rpc("record_ses_docket_review_state_v1", {
      p_event: {
        docket_revision_id: boundDocket.id,
        event_kind: "prepared",
        expected_output_content_hash: boundDocket.output_content_hash ||
          docketHash,
        actor_identity: args.actor,
        reason:
          "The AUTHORISED Xero PDF changed the exact pack bytes and requires a fresh Captain tick.",
      },
    }),
    "The invoice-bound pack could not be queued for a fresh Docs Ready review.",
  );
  return {
    state: "authorised_invoice_bound",
    invoice: authorisedInvoice,
    docket_revision: boundDocket,
    invoice_create_dispatched: created.dispatched,
    invoice_authorise_dispatched: authorised.dispatched,
    send_dispatched: false,
  };
}

export async function prepareSesReleaseRevisionAction(
  client: SesSupabaseClient,
  args: {
    org_id: string;
    job_ids: string[];
    routes?: SesReviewRoute[];
    created_by: string;
  },
) {
  const dockets = await Promise.all(
    args.job_ids.map((jobId) => loadSesCockpitDocket(client, jobId)),
  );
  const routes = args.routes ||
    (dockets.length === 1 ? dockets[0].routes : []);
  const plan = await buildSesReleaseRevision({
    org_id: args.org_id,
    members: dockets.map((docket) => ({
      job_id: docket.job_id,
      docket_revision_id: docket.docket_revision_id,
      invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
      attendance_cycle_ids: docket.attendance_cycle_ids,
      readiness_revision: docket.readiness_revision,
      dependency_generation: docket.dependency_generation,
    })),
    routes,
    created_by: args.created_by,
  });
  const committed = await client.rpc("commit_ses_release_revision_v1", {
    p_release: plan.release,
    p_members: plan.members,
    p_routes: plan.routes,
  });
  return {
    ...plan,
    commit: requireValue(
      committed,
      "The content-addressed release revision could not be committed.",
    ),
    external_mutations: { xero: 0, email: 0 },
  };
}

export async function approveSesReleaseRevisionAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    release_revision_id: string;
    evidence_refs?: unknown[];
  },
) {
  const release = requireValue(
    await client.from("makesafe_release_revisions").select("*")
      .eq("id", args.release_revision_id).maybeSingle(),
    "The displayed release revision no longer exists.",
  );
  const membersResponse = await client.from("makesafe_release_revision_members")
    .select("*").eq("release_revision_id", args.release_revision_id)
    .order("ordinal");
  const members = membersResponse.data || [];
  if (membersResponse.error || members.length === 0) {
    throw new SesActionError(409, {
      state: "refused",
      fact: "The displayed release revision has no complete member docket set.",
    });
  }
  const operatorAuth = await loadOperatorAuth(client, auth);
  if (operatorAuth.mode !== "jwt" || !auth.user) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "Human SEND IT approval requires an identified SES operator session; API keys and automation keys cannot approve.",
    });
  }
  const approvals = [];
  for (const member of members) {
    const docket = await loadSesCockpitDocket(client, member.job_id);
    const verdict = evaluateSesMechanicalClean(docket.clean_input);
    const authority = canRecordSesApproval(operatorAuth, verdict);
    const cockpit = buildSesCockpitView(docket);
    if (
      !authority.allowed || (!cockpit.controls.send_it.enabled &&
        !authority.captain_override)
    ) {
      throw new SesActionError(
        409,
        verdict.blockers[0] ||
          sesRefusal(
            "xero_not_authorised",
            "Bind the real AUTHORISED Xero PDF to the current docket before SEND IT.",
          ),
      );
    }
    if (
      member.docket_revision_id !== docket.docket_revision_id ||
      !release.readiness_bindings.some((binding: any) =>
        binding.job_id === docket.job_id &&
        binding.readiness_revision === docket.readiness_revision &&
        Number(binding.dependency_generation) ===
          docket.dependency_generation
      )
    ) {
      throw new SesActionError(
        409,
        sesRefusal(
          "stale_review",
          "Prepare and review a release revision from the newest docket evidence.",
        ),
      );
    }
    if (docket.clean_input.pricing_disposition === "no_additional_charge") {
      const noChargeRevision = await client.from(
        "makesafe_invoice_obligation_revisions",
      ).select("id").eq("id", member.invoice_obligation_revision_id)
        .eq("pricing_disposition", "no_additional_charge")
        .eq("state", "proposed")
        .maybeSingle();
      if (noChargeRevision.error || !noChargeRevision.data) {
        throw new SesActionError(409, {
          state: "refused",
          fact:
            "The current later attendance is not recorded as a proposed no-additional-charge obligation.",
        });
      }
    } else {
      const boundDocket = requireValue(
        await client.from("makesafe_docket_revisions")
          .select("based_on_revision_id,invoice_obligation_revision_id")
          .eq("id", member.docket_revision_id)
          .eq("stage", "invoice_bound")
          .maybeSingle(),
        "The displayed release is not bound to a real AUTHORISED Xero PDF docket.",
      );
      const invoiceApproval = await client.from("makesafe_revision_approvals")
        .select("id")
        .eq("action", "invoice")
        .eq("decision", "approved")
        .eq(
          "invoice_obligation_revision_id",
          boundDocket.invoice_obligation_revision_id,
        )
        .eq("docket_revision_id", boundDocket.based_on_revision_id)
        .eq("includes_authorise", true)
        .order("decided_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (invoiceApproval.error || !invoiceApproval.data) {
        throw new SesActionError(
          409,
          sesRefusal(
            "invoice_approval_missing",
            "Review the exact invoice proposal and press APPROVE INVOICE with authorise included before SEND IT.",
          ),
        );
      }
    }
    const approved = await client.rpc("record_ses_revision_approval_v1", {
      p_approval: {
        org_id: args.org_id,
        job_id: member.job_id,
        action: "release",
        operator_id: auth.user.id,
        is_admin_owner: ["admin", "owner"].includes(auth.user.role),
        clean: verdict.clean,
        captain_override: authority.captain_override,
        readiness_revision: docket.readiness_revision,
        dependency_generation: docket.dependency_generation,
        docket_revision_id: docket.docket_revision_id,
        release_revision_id: args.release_revision_id,
        invoice_obligation_revision_id: docket.invoice_obligation_revision_id,
        approval_content_hash: release.content_hash,
        includes_authorise: false,
        decided_by: auth.user.email || auth.user.id,
        evidence_refs: args.evidence_refs || [],
      },
    });
    approvals.push(
      requireValue(approved, "The SEND IT approval could not be recorded."),
    );
  }
  const releaseState = await client.from("makesafe_release_revisions").update({
    state: "approved",
    updated_at: new Date().toISOString(),
  }).eq("id", args.release_revision_id).in("state", [
    "proposed",
    "approved",
  ]).select("id").maybeSingle();
  requireValue(
    releaseState,
    "The exact release revision approval was recorded, but its SEND IT state could not be stored.",
  );
  return {
    release_revision_id: args.release_revision_id,
    approvals,
    controls: {
      approve_invoice: "separate",
      send_it: "recorded",
    },
  };
}

export interface SesRouteSendResult {
  message_id: string;
  internet_message_id?: string;
  state: "sent";
  operation_token: string;
}

export interface SesMailGateway {
  createDraftAndSend(
    route: Record<string, any>,
    context: { external_token: string; operation_key: string },
  ): Promise<SesRouteSendResult>;
  reconcileSent(externalToken: string): Promise<SesRouteSendResult[]>;
}

export interface SesReleaseXeroReader {
  readAuthorised(invoiceId: string): Promise<boolean>;
}

export async function assertSesDocketsSignedOffForSend(
  client: SesSupabaseClient,
  docketRevisionIds: string[],
): Promise<void> {
  const exactIds = [...new Set(docketRevisionIds.filter(Boolean))].sort();
  const asserted = await client.rpc("assert_ses_dockets_signed_off_v1", {
    p_docket_revision_ids: exactIds,
  });
  if (asserted.error || !asserted.data) {
    throw new SesActionError(
      409,
      sesRefusal(
        "docs_ready_signoff_missing",
        "Open each current reviewable pack and record the Captain tick before SEND IT.",
        {
          fact: asserted.error?.message ||
            "No current Captain Docs Ready signoff covers every exact release member.",
          evidence: { docket_revision_ids: exactIds },
        },
      ),
    );
  }
}

export async function executeSesReleaseRevisionAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    org_id: string;
    release_revision_id: string;
    actor: string;
  },
  mailGateway: SesMailGateway,
  xeroReader: SesReleaseXeroReader,
) {
  if (auth.mode === "routine") {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "The make-safe automation key cannot execute a human-approved builder release.",
    });
  }
  const release = requireValue(
    await client.from("makesafe_release_revisions").select("*")
      .eq("id", args.release_revision_id).maybeSingle(),
    "The approved release revision no longer exists.",
  );
  const membersResponse = await client.from("makesafe_release_revision_members")
    .select("*").eq("release_revision_id", args.release_revision_id)
    .order("ordinal");
  const routesResponse = await client.from("makesafe_release_revision_routes")
    .select("*").eq("release_revision_id", args.release_revision_id)
    .order("ordinal");
  const members = membersResponse.data || [];
  const routes = routesResponse.data || [];
  if (
    membersResponse.error || routesResponse.error ||
    members.length === 0 || routes.length !== 3
  ) {
    throw new SesActionError(409, {
      state: "refused",
      fact:
        "The approved release does not contain the exact member set and all three required routes.",
    });
  }
  await assertSesDocketsSignedOffForSend(
    client,
    members.map((member: any) => String(member.docket_revision_id || "")),
  );
  requireValue(
    await client.rpc("begin_ses_release_execution_v1", {
      p_release_revision_id: args.release_revision_id,
      p_release_content_hash: release.content_hash,
    }),
    "The current readiness rows and exact SEND IT release could not be reserved for execution.",
  );
  for (const member of members) {
    const approval = await client.from(
      "makesafe_revision_approvals_current_v2",
    ).select("id,approval_content_hash").eq("action", "release")
      .eq("release_revision_id", args.release_revision_id)
      .eq("job_id", member.job_id).limit(1).maybeSingle();
    if (
      approval.error || !approval.data ||
      approval.data.approval_content_hash !== release.content_hash
    ) {
      throw new SesActionError(
        409,
        sesRefusal(
          "release_approval_missing",
          "Open the current composite cockpit and press SEND IT again.",
        ),
      );
    }
    const docket = requireValue(
      await client.from("makesafe_docket_revisions").select(
        "id,xero_binding,invoice_obligation_revision_id",
      ).eq("id", member.docket_revision_id).maybeSingle(),
      "A release member's exact docket revision no longer exists.",
    );
    const xero = object(docket.xero_binding);
    if (xero.status === "AUTHORISED") {
      if (
        !await xeroReader.readAuthorised(String(xero.xero_invoice_id || ""))
      ) {
        throw new SesActionError(
          409,
          sesRefusal(
            "xero_not_authorised",
            "Refresh and authorise the exact Xero invoice, then prepare and approve a new release revision.",
          ),
        );
      }
    } else {
      const noChargeRevision = await client.from(
        "makesafe_invoice_obligation_revisions",
      ).select("id").eq(
        "id",
        member.invoice_obligation_revision_id,
      ).eq("pricing_disposition", "no_additional_charge")
        .eq("state", "proposed").maybeSingle();
      if (noChargeRevision.error || !noChargeRevision.data) {
        throw new SesActionError(
          409,
          sesRefusal(
            "xero_not_authorised",
            "Bind the real AUTHORISED Xero invoice or record this later attendance as no additional charge before release.",
          ),
        );
      }
    }
  }

  const store = createSupabaseSesEffectStore(client);
  const routeProofs = [];
  const exactDocketRevisionIds = members.map((member: any) =>
    String(member.docket_revision_id || "")
  );
  for (const kind of SES_ROUTE_ORDER) {
    const route = routes.find((candidate: any) =>
      candidate.route_kind === kind
    );
    if (!route) {
      throw new SesActionError(
        409,
        sesRefusal(
          "route_draft_missing",
          `Prepare and approve the missing ${kind} route on a new release revision.`,
        ),
      );
    }
    await assertSesDocketsSignedOffForSend(
      client,
      exactDocketRevisionIds,
    );
    const effect = await buildSesEffect({
      org_id: args.org_id,
      effect_kind: "route_send",
      release_revision_id: args.release_revision_id,
      route_kind: kind,
      payload: {
        recipients: route.recipients,
        cc: route.cc,
        subject: route.subject,
        body: route.body,
        body_hash: route.body_hash,
        attachment_hashes: route.attachment_hashes,
      },
    });
    const adapter: SesExternalAdapter<
      Record<string, any>,
      SesRouteSendResult
    > = {
      dispatch: (payload, context) =>
        mailGateway.createDraftAndSend(payload, context),
      reconcile: (context) => mailGateway.reconcileSent(context.external_token),
      identify: (result) => result.message_id,
      digest: (result) => ({
        message_id: result.message_id,
        internet_message_id: result.internet_message_id || null,
        operation_token: result.operation_token,
      }),
    };
    const sent = await executeSesExternalEffect({
      store,
      effect,
      payload: route,
      adapter,
      actor: args.actor,
    });
    if (sent.state !== "confirmed") {
      throw new SesActionError(409, sent.refusal!);
    }
    const result = sent.result ||
      await mailGateway.reconcileSent(effect.external_token).then((rows) =>
        rows[0]
      );
    if (!result) {
      throw new SesActionError(
        409,
        sesRefusal(
          "graph_outcome_unknown",
          "Reconcile Sent Items by the exact SES operation token; never send this route again.",
        ),
      );
    }
    const proofHash = await sesSha256({
      release_revision_id: args.release_revision_id,
      route_kind: kind,
      effect_operation_key: effect.operation_key,
      external_token: effect.external_token,
      external_message_id: result.message_id,
      members,
    }, "SecureWorks:ses-release-route-proof:v1\n");
    const proof = await client.rpc("confirm_ses_release_route_v1", {
      p_release_revision_id: args.release_revision_id,
      p_route_kind: kind,
      p_proof_hash: proofHash,
      p_actor: args.actor,
    });
    routeProofs.push(
      requireValue(proof, `The confirmed ${kind} route proof was not stored.`),
    );
  }

  const proofHashes = routeProofs.map((proof) => proof.proof_hash).sort();
  const closeoutHash = await sesSha256({
    release_revision_id: args.release_revision_id,
    required_proof_hashes: proofHashes,
  }, "SecureWorks:ses-release-closeout:v1\n");
  const closeout = await client.rpc("commit_ses_release_closeout_v1", {
    p_closeout: {
      id: stableUuidFromSha256(closeoutHash),
      org_id: args.org_id,
      release_revision_id: args.release_revision_id,
      content_hash: closeoutHash,
      required_proof_hashes: proofHashes,
      created_by: args.actor,
    },
  });
  const committedCloseout = requireValue(
    closeout,
    "Every route sent, but the exact release closeout could not be verified.",
  );
  const verification = await client.from("makesafe_closeout_revisions")
    .select(
      "id,release_revision_id,content_hash,required_proof_hashes,verified,verified_at",
    )
    .eq("id", committedCloseout.id)
    .eq("release_revision_id", args.release_revision_id)
    .eq("verified", true)
    .maybeSingle();
  if (
    verification.error || !verification.data ||
    verification.data.content_hash !== closeoutHash ||
    JSON.stringify(
        [...(verification.data.required_proof_hashes || [])].sort(),
      ) !== JSON.stringify(proofHashes)
  ) {
    throw new SesActionError(503, {
      state: "refused",
      fact:
        "All three routes are sent, but the independent closeout read-back does not prove the exact route-proof set; do not send again.",
    });
  }
  return {
    state: "released",
    release_revision_id: args.release_revision_id,
    release_content_hash: release.content_hash,
    route_proofs: routeProofs,
    closeout: verification.data,
  };
}

export async function querySesProofLedgerAction(
  client: SesSupabaseClient,
  releaseRevisionId: string,
) {
  const response = await client.from("ses_release_proof_ledger")
    .select("*").eq("release_revision_id", releaseRevisionId)
    .order("route_kind");
  if (response.error) {
    throw new SesActionError(503, {
      state: "refused",
      fact: `The release proof ledger could not be read (${
        response.error.message || "unknown database error"
      }).`,
    });
  }
  return { proofs: response.data || [] };
}

export async function recordSesReviewFeedbackAction(
  client: SesSupabaseClient,
  auth: SesActionAuth,
  args: {
    docket_revision_id: string;
    job_id: string;
    change_type: string;
    before: unknown;
    after: unknown;
  },
) {
  const operatorAuth = await loadOperatorAuth(client, auth);
  const identifiedOperator = operatorAuth.mode === "jwt" &&
    !!auth.user &&
    (
      !!operatorAuth.operator_class ||
      ["admin", "owner"].includes(auth.user.role)
    );
  if (!identifiedOperator || !auth.user) {
    throw new SesActionError(403, {
      state: "refused",
      fact:
        "Review feedback has no identified SES operator; sign in as an allowlisted reviewer or admin-owner.",
    });
  }
  const inserted = await client.rpc("record_ses_review_feedback_v1", {
    p_feedback: {
      docket_revision_id: args.docket_revision_id,
      job_id: args.job_id,
      change_type: args.change_type,
      before: args.before,
      after: args.after,
      operator_id: auth.user.id,
      operator: auth.user.email || auth.user.id,
    },
  });
  return {
    feedback: requireValue(
      inserted,
      "The review feedback entry could not be appended.",
    ),
    release_executed: false,
  };
}

export function sesActionErrorResponse(error: unknown): {
  status: number;
  body: Record<string, unknown>;
} | null {
  if (error instanceof SesActionError) {
    return {
      status: error.status,
      body: {
        success: false,
        refusal: error.refusal,
        error: error.refusal.fact,
      },
    };
  }
  if (isSesRefusal(error)) {
    return {
      status: 409,
      body: { success: false, refusal: error, error: error.fact },
    };
  }
  return null;
}
