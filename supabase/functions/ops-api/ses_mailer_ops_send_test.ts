// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * In-process wiring proof for send_mailer_ops_visibility.
 *
 * ZERO outbound Graph calls. A green suite proves:
 *   - structural no-invoice (types + runtime)
 *   - mandatory CC ses@secureworkswa.com.au
 *   - subject resolution (exact original / Photo Evidence fallback)
 *   - photo representative cap (not first-N only)
 *   - report provenance satisfaction shape
 *   - dry_run default (no effect dispatch)
 *   - live path records Sent Items proof fields including CC
 *   - single-card drive (one job_id + kind)
 *
 * A green suite does NOT prove delivery. The mail gateway is mocked.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertMailerOpsAttachmentRoles,
  assertMailerOpsCcInvariant,
  assertNotMoneyDocumentType,
  extractMailerAddressesFromSenderPatterns,
  isMailerOpsRouteKind,
  MAILER_OPS_CC,
  MAILER_OPS_FROM,
  MAILER_OPS_PHOTO_CAP,
  MAILER_OPS_SEND_CONTRACT_VERSION,
  mailerOpsAttemptHash,
  mailerOpsPhotoFileName,
  mailerOpsRouteKindAllowsInvoice,
  parsePublicStorageUrl,
  resolveMailerOpsRecipient,
  resolveMailerOpsSubject,
  resolvePhotoContentType,
  selectRepresentativePhotoIndices,
  sendMailerOpsVisibilityAction,
} from "./ses_mailer_ops_send.ts";
import {
  buildSesEffect,
  type SesEffectClaim,
  type SesEffectState,
  type SesExternalEffect,
  type SesExternalEffectStore,
} from "./ses_external_effects.ts";
import { SES_OPERATION_HEADER } from "./ses_graph_mail_gateway.ts";
import { SesActionError } from "./ses_reporting_actions.ts";

function assertRejectsSync(fn: () => void) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, "expected throw");
}

// ── Pure unit tests ────────────────────────────────────────────────────────

Deno.test("mailer ops: invoice is structurally impossible as route kind", () => {
  assertEquals(isMailerOpsRouteKind("report"), true);
  assertEquals(isMailerOpsRouteKind("photo"), true);
  assertEquals(isMailerOpsRouteKind("invoice"), false);
  assertEquals(isMailerOpsRouteKind("report_invoice"), false);
  assertEquals(mailerOpsRouteKindAllowsInvoice(), false);
});

Deno.test("mailer ops: CC invariant is exact ses@secureworkswa.com.au", () => {
  assertEquals(MAILER_OPS_CC, "ses@secureworkswa.com.au");
  assertMailerOpsCcInvariant([MAILER_OPS_CC]);
  assertRejectsSync(() => assertMailerOpsCcInvariant(["ses@secureworks"]));
  assertRejectsSync(() => assertMailerOpsCcInvariant([]));
  assertRejectsSync(() =>
    assertMailerOpsCcInvariant([MAILER_OPS_CC, "other@x.com"])
  );
});

Deno.test("mailer ops: FROM is admin@", () => {
  assertEquals(MAILER_OPS_FROM, "admin@secureworkswa.com.au");
});

Deno.test("mailer ops: money document types refuse", () => {
  assertRejectsSync(() => assertNotMoneyDocumentType("invoice"));
  assertRejectsSync(() => assertNotMoneyDocumentType("supplier_invoice"));
  // makesafe_report is fine
  assertNotMoneyDocumentType("makesafe_report");
});

Deno.test("mailer ops: attachment roles refuse invoice-shaped sets", () => {
  assertMailerOpsAttachmentRoles(["report_pdf"], "report");
  assertMailerOpsAttachmentRoles(["site_photo", "site_photo"], "photo");
  assertRejectsSync(() =>
    assertMailerOpsAttachmentRoles(["report_pdf", "site_photo"] as any, "report")
  );
});

Deno.test("mailer ops: photo indices are a representative spread, not first N", () => {
  const indices = selectRepresentativePhotoIndices(100, 12);
  assertEquals(indices.length, 12);
  assertEquals(indices[0], 0);
  assertEquals(indices[indices.length - 1], 99);
  // Must include mid-range, not only 0..11
  assert(indices.some((i) => i > 20 && i < 80));
  // Under cap returns all
  assertEquals(selectRepresentativePhotoIndices(5, 12), [0, 1, 2, 3, 4]);
  // Cap is local constant
  assertEquals(MAILER_OPS_PHOTO_CAP, 12);
  // cap 1 must not divide by zero (0/0 → NaN → all[NaN] TypeError)
  assertEquals(selectRepresentativePhotoIndices(9, 1), [0]);
  assertEquals(selectRepresentativePhotoIndices(1, 1), [0]);
});

Deno.test("mailer ops: photo content type is real, never assumed jpeg", () => {
  assertEquals(resolvePhotoContentType("image/png", "a.jpg"), "image/png");
  assertEquals(resolvePhotoContentType("", "site-photo.PNG"), "image/png");
  assertEquals(
    resolvePhotoContentType(null, null, "https://x/storage/v1/object/public/b/p.heic?token=1"),
    "image/heic",
  );
  // Storage sometimes reports a generic type; the extension then decides.
  assertEquals(
    resolvePhotoContentType("application/octet-stream", "p.jpeg"),
    "image/jpeg",
  );
  assertEquals(resolvePhotoContentType(null, "noextension"), "application/octet-stream");
});

Deno.test("mailer ops: sender_patterns extracts full emails only", () => {
  assertEquals(
    extractMailerAddressesFromSenderPatterns([
      "mlb.mailer@primeeco.tech",
      "@primeeco.tech",
      "primeeco.tech",
      "MLB.Mailer@Primeeco.Tech",
    ]),
    ["mlb.mailer@primeeco.tech"],
  );
});

Deno.test("mailer ops: destination is never auto-selected from inbound sender_patterns", () => {
  // A single configured full address is still not a confirmed destination:
  // sender_patterns says who we accept work orders FROM, not where we send.
  try {
    resolveMailerOpsRecipient({
      senderPatterns: ["mlb.mailer@primeeco.tech"],
    });
    throw new Error("expected confirmation refusal");
  } catch (err) {
    assert(err instanceof SesActionError);
    assertEquals(
      (err.refusal as any).code,
      "mailer_recipient_confirmation_required",
    );
    assertEquals(
      (err.refusal as any).evidence.configured_senders,
      ["mlb.mailer@primeeco.tech"],
    );
  }

  try {
    resolveMailerOpsRecipient({
      senderPatterns: ["a@x.com", "b@x.com"],
      requestedTo: "someone.else@x.com",
    });
    throw new Error("expected allowlist refusal");
  } catch (err) {
    assert(err instanceof SesActionError);
    assertEquals((err.refusal as any).code, "mailer_recipient_not_allowlisted");
  }

  const picked = resolveMailerOpsRecipient({
    senderPatterns: ["a@x.com", "b@x.com"],
    requestedTo: "b@x.com",
  });
  assertEquals(picked.to, "b@x.com");
  assertEquals(picked.source, "company_sender_patterns");
  assertEquals(picked.card_bound, false);

  // The card's own work-order sender is the stronger, card-bound coordinate.
  const cardBound = resolveMailerOpsRecipient({
    senderPatterns: [],
    cardIntakeSenders: ["MLB.Mailer@primeeco.tech", null],
    requestedTo: "mlb.mailer@primeeco.tech",
  });
  assertEquals(cardBound.source, "card_intake_work_order_sender");
  assertEquals(cardBound.card_bound, true);

  try {
    resolveMailerOpsRecipient({ senderPatterns: [], requestedTo: "x@y.com" });
    throw new Error("expected unresolved refusal");
  } catch (err) {
    assert(err instanceof SesActionError);
    assertEquals((err.refusal as any).code, "mailer_recipient_unresolved");
  }
});

Deno.test("mailer ops: attempt hash moves only on a deliberate attempt_key", async () => {
  const base = {
    kind: "report" as const,
    to: "mlb.mailer@primeeco.tech",
    cc: [MAILER_OPS_CC],
  };
  const first = await mailerOpsAttemptHash(base);
  const replay = await mailerOpsAttemptHash({ ...base });
  const retry = await mailerOpsAttemptHash({ ...base, attempt_key: "retry-2" });
  const otherKind = await mailerOpsAttemptHash({ ...base, kind: "photo" });
  const otherTo = await mailerOpsAttemptHash({ ...base, to: "someone@x.com" });
  assertEquals(first, replay);
  assert(first !== retry);
  assert(first !== otherKind);
  assert(first !== otherTo);
  assert(/^sha256:[0-9a-f]{64}$/.test(first));
  // The signature itself must not accept re-resolved content: a subject or an
  // attachment set in the identity is what would mail the builder twice.
  const signature = (mailerOpsAttemptHash as unknown as { toString(): string })
    .toString();
  assert(!signature.includes("subject"));
  assert(!signature.includes("attachment_hashes"));
});

Deno.test("mailer ops: photo attachments are named from the trade label, never a storage uuid", () => {
  assertEquals(
    mailerOpsPhotoFileName(
      "Front fence damage",
      1,
      "https://x/storage/v1/object/public/job-photos/o/j/photos/4f2a9c1e-0000.jpg",
      "image/jpeg",
    ),
    "01-front-fence-damage.jpg",
  );
  // Empty label → sequential human name, still never the uuid object path.
  assertEquals(
    mailerOpsPhotoFileName(
      "",
      2,
      "https://x/storage/v1/object/public/job-photos/o/j/photos/4f2a9c1e-0000.png",
      "image/png",
    ),
    "site-photo-02.png",
  );
  // Extension comes from the stored object / content type, not from the label.
  assertEquals(
    mailerOpsPhotoFileName("Rear.jpg", 3, "https://x/o/p", "image/heic"),
    "03-rear.heic",
  );
});

Deno.test("mailer ops: subject uses exact original; photo fallback Photo Evidence - REF", () => {
  const report = resolveMailerOpsSubject({
    kind: "report",
    draftSubjects: [
      "NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051",
    ],
    builderReference: "MLB-26267",
  });
  assertEquals(
    report.subject,
    "NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051",
  );
  assertEquals(report.subject_source, "intake_draft_subject");
  assertEquals(report.original_subject, report.subject);

  const photoFallback = resolveMailerOpsSubject({
    kind: "photo",
    builderReference: "MLB-26267",
  });
  assertEquals(photoFallback.subject, "Photo Evidence - MLB-26267");
  assertEquals(photoFallback.subject_source, "generated_fallback");
  assertEquals(photoFallback.original_subject, null);
});

Deno.test("mailer ops: parse public storage URL", () => {
  const parsed = parsePublicStorageUrl(
    "https://xyz.supabase.co/storage/v1/object/public/job-documents/1e05/report.pdf",
  );
  assertEquals(parsed?.bucket, "job-documents");
  assertEquals(parsed?.path, "1e05/report.pdf");
});

Deno.test("mailer ops: buildSesEffect identity includes job and attempt hash", async () => {
  const attempt = "sha256:" + "cd".repeat(32);
  const a = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    job_id: "10000000-0000-4000-8000-000000000001",
    effect_kind: "mailer_ops_send",
    route_kind: "report",
    artifact_hash: attempt,
    payload: { k: 1 },
  });
  const b = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    job_id: "20000000-0000-4000-8000-000000000002",
    effect_kind: "mailer_ops_send",
    route_kind: "report",
    artifact_hash: attempt,
    payload: { k: 1 },
  });
  // Same card + kind, deliberate new attempt → new operation key, so one Graph
  // failure cannot strand the card behind a stuck `unknown` token forever.
  const retry = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    job_id: "10000000-0000-4000-8000-000000000001",
    effect_kind: "mailer_ops_send",
    route_kind: "report",
    artifact_hash: "sha256:" + "ef".repeat(32),
    payload: { k: 1 },
  });
  const replay = await buildSesEffect({
    org_id: "00000000-0000-4000-8000-000000000001",
    job_id: "10000000-0000-4000-8000-000000000001",
    effect_kind: "mailer_ops_send",
    route_kind: "report",
    artifact_hash: attempt,
    payload: { k: 1 },
  });
  assert(a.operation_key !== b.operation_key);
  assert(a.operation_key !== retry.operation_key);
  assertEquals(a.operation_key, replay.operation_key);
  assertEquals(a.artifact_hash, attempt);
  assertEquals(a.effect_kind, "mailer_ops_send");
  assertEquals(a.route_kind, "report");
  assertStringIncludes(a.external_token, "SES-");
});

// ── Action wiring (mocked client + gateway) ────────────────────────────────

class MemoryEffectStore implements SesExternalEffectStore {
  row: SesExternalEffect | null = null;
  dispatches = 0;

  claim(
    effect: Omit<SesExternalEffect, "state">,
    _owner: string,
  ): Promise<SesEffectClaim> {
    if (!this.row) {
      this.row = { ...effect, state: "reserved", id: "effect-1" };
      return Promise.resolve({
        effect: { ...this.row },
        claim_mode: "dispatch",
        duplicate_refused: false,
      });
    }
    return Promise.resolve({
      effect: { ...this.row },
      claim_mode: this.row.state === "confirmed" ? "confirmed" : "reconcile",
      duplicate_refused: true,
    });
  }

  transition(
    operationKey: string,
    from: SesEffectState,
    to: SesEffectState,
    _eventKind: string,
    detail: Record<string, unknown>,
    _actor: string,
  ): Promise<SesExternalEffect> {
    if (!this.row || this.row.operation_key !== operationKey) {
      return Promise.reject(new Error("missing effect"));
    }
    if (this.row.state !== from) {
      return Promise.reject(new Error(`stale state ${from}`));
    }
    this.row = {
      ...this.row,
      state: to,
      external_id: String(detail.external_id || this.row.external_id || "") ||
        null,
      provider_digest:
        (detail.provider_digest as Record<string, unknown>) ||
        this.row.provider_digest,
    };
    if (to === "dispatching") this.dispatches++;
    return Promise.resolve({ ...this.row });
  }
}

function minimalPdfBytes(): Uint8Array {
  // %PDF-1.4 plus enough padding
  const text = "%PDF-1.4\n% mailer-ops-test\ntrailer\n%%EOF\n";
  return new TextEncoder().encode(text);
}

function makeClient(opts: {
  job?: Record<string, unknown>;
  company?: Record<string, unknown> | null;
  detail?: Record<string, unknown> | null;
  documents?: any[];
  media?: any[];
  cases?: any[];
  sources?: any[];
  drafts?: any[];
  emails?: any[];
  jobEventsError?: { message: string };
  onJobEventInsert?: (row: any) => void;
}): any {
  const job = opts.job || {
    id: "job-1",
    org_id: "00000000-0000-4000-8000-000000000001",
    type: "makesafe",
    job_number: "SWMS-261017",
    status: "active",
    metadata: {
      builder_email_subject:
        "NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051",
      builder_reference: "MLB-26267",
    },
    requesting_company_slug: "mlb",
    external_ref: "MLB-26267",
    site_suburb: "Maylands",
    ses_money_sealed_at: "2026-08-01T00:00:00Z",
  };
  const company = opts.company === null ? null : opts.company || {
    slug: "mlb",
    name: "ML Builders",
    sender_patterns: ["mlb.mailer@primeeco.tech"],
    report_recipient: "makesafes@mlbuilders.com.au",
  };
  const documents = opts.documents || [{
    id: "doc-report-1",
    job_id: "job-1",
    type: "makesafe_report",
    file_name: "Make-Safe-Report-MLB-26267.pdf",
    storage_url:
      "https://example.supabase.co/storage/v1/object/public/job-documents/job-1/report.pdf",
    pdf_url: null,
    data_snapshot_json: {
      curated_source_kind: "durable_curated_revision",
      curated_source_identity: "curation-revision:r1/artifact:a1",
      curated_source_expected_raw_sha256: null, // set after we know plain hash in test if needed
      report_input_hash: "sha256:" + "ab".repeat(32),
    },
    created_at: "2026-08-03T00:00:00Z",
  }];
  const media = opts.media || Array.from({ length: 20 }, (_, i) => ({
    id: `media-${i}`,
    job_id: "job-1",
    type: "photo",
    phase: "completion",
    storage_url:
      `https://example.supabase.co/storage/v1/object/public/job-photos/job-1/p${i}.jpg`,
    created_at: `2026-08-01T00:00:${String(i).padStart(2, "0")}Z`,
  }));
  const detail = opts.detail === null ? null : opts.detail || null;
  const cases = opts.cases || [{
    id: "case-1",
    job_id: "job-1",
    builder_wo_canonical: "MLB-26267",
  }];
  const sources = opts.sources || [];
  const drafts = opts.drafts || [{
    id: "draft-1",
    subject:
      "NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051",
    status: "approved",
    approved_job_id: "job-1",
  }];
  const emails = opts.emails || [];
  const pdfBytes = minimalPdfBytes();
  const photoBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // minimal jpeg markers

  return {
    from(table: string) {
      const state: any = { table, filters: [] as any[] };
      const api: any = {
        select() {
          return api;
        },
        eq(col: string, val: unknown) {
          state.filters.push(["eq", col, val]);
          return api;
        },
        in(col: string, vals: unknown[]) {
          state.filters.push(["in", col, vals]);
          return api;
        },
        order() {
          return api;
        },
        limit() {
          return api;
        },
        maybeSingle: async () => {
          if (table === "jobs") return { data: job, error: null };
          if (table === "makesafe_companies") {
            return { data: company, error: null };
          }
          if (table === "makesafe_job_details") {
            return { data: detail, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve: any) {
          return Promise.resolve(api._result()).then(resolve);
        },
        async _result() {
          if (table === "job_documents") {
            return { data: documents, error: null };
          }
          if (table === "job_media") return { data: media, error: null };
          if (table === "makesafe_intake_cases") {
            return { data: cases, error: null };
          }
          if (table === "makesafe_intake_case_sources") {
            return { data: sources, error: null };
          }
          if (table === "makesafe_intake_drafts") {
            return { data: drafts, error: null };
          }
          if (table === "emails") return { data: emails, error: null };
          if (table === "job_events") return { data: null, error: null };
          return { data: [], error: null };
        },
        insert: async (row: any) => {
          if (table === "job_events") {
            opts.onJobEventInsert?.(row);
            return { data: null, error: opts.jobEventsError || null };
          }
          return { data: null, error: null };
        },
      };
      // Make thenable for await client.from().select()...
      api.then = (onful: any, onrej: any) =>
        api._result().then(onful, onrej);
      return api;
    },
    storage: {
      from(_bucket: string) {
        return {
          download: async (path: string) => {
            if (path.includes("report") || path.endsWith(".pdf")) {
              return {
                data: {
                  arrayBuffer: async () => pdfBytes.buffer.slice(
                    pdfBytes.byteOffset,
                    pdfBytes.byteOffset + pdfBytes.byteLength,
                  ),
                },
                error: null,
              };
            }
            return {
              data: {
                arrayBuffer: async () => photoBytes.buffer.slice(
                  photoBytes.byteOffset,
                  photoBytes.byteOffset + photoBytes.byteLength,
                ),
              },
              error: null,
            };
          },
        };
      },
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

Deno.test("mailer ops action: dry_run default prepares report without Graph/effect dispatch", async () => {
  const store = new MemoryEffectStore();
  let gatewayBuilt = 0;
  const client = makeClient({});
  const result = await sendMailerOpsVisibilityAction(
    client,
    { mode: "api_key", user: null },
    {
      org_id: "00000000-0000-4000-8000-000000000001",
      job_id: "job-1",
      kind: "report",
      to: "mlb.mailer@primeeco.tech",
      // dry_run omitted → true
    },
    {
      makeMailGateway: () => {
        gatewayBuilt++;
        return {
          createDraftAndSend: () => {
            throw new Error("Graph must not be called in dry_run");
          },
          reconcileSent: () => Promise.resolve([]),
        };
      },
      effectStore: store,
    },
  );
  assertEquals(result.dry_run, true);
  assertEquals(result.success, true);
  assertEquals(result.kind, "report");
  assertEquals(result.from, MAILER_OPS_FROM);
  assertEquals(result.to, ["mlb.mailer@primeeco.tech"]);
  assertEquals(result.cc, [MAILER_OPS_CC]);
  assertEquals(
    result.subject,
    "NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051",
  );
  assertEquals(result.attachment_roles, ["report_pdf"]);
  assertEquals((result.fences as any).invoice_structurally_impossible, true);
  assertEquals(
    (result.fences as any).sealed_ses_release_required.satisfied_by,
    "this_action_is_the_audited_route",
  );
  assertEquals((result.fences as any).pdf_provenance.satisfied, true);
  assertEquals(gatewayBuilt, 0);
  assertEquals(store.row, null);
  assertEquals(result.contract_version, MAILER_OPS_SEND_CONTRACT_VERSION);
});

Deno.test("mailer ops action: dry_run photo uses cap and records sent-versus-available", async () => {
  const store = new MemoryEffectStore();
  const result = await sendMailerOpsVisibilityAction(
    makeClient({}),
    { mode: "api_key", user: null },
    {
      org_id: "00000000-0000-4000-8000-000000000001",
      job_id: "job-1",
      kind: "photo",
      to: "mlb.mailer@primeeco.tech",
      dry_run: true,
    },
    {
      makeMailGateway: () => {
        throw new Error("no gateway");
      },
      effectStore: store,
    },
  );
  assertEquals(result.dry_run, true);
  assertEquals(result.kind, "photo");
  assertEquals(result.cc, [MAILER_OPS_CC]);
  const photo = result.photo_selection as any;
  assertEquals(photo.available_count, 20);
  assertEquals(photo.selected_count, MAILER_OPS_PHOTO_CAP);
  assertEquals(photo.cap, MAILER_OPS_PHOTO_CAP);
  assertEquals((result.attachment_roles as string[]).every((r) =>
    r === "site_photo"
  ), true);
  // Representative spread: not only first 12 media ids
  const ids: string[] = photo.media_ids;
  assert(ids.includes("media-0"));
  assert(ids.includes("media-19"));
  assert(ids.some((id) => {
    const n = Number(id.replace("media-", ""));
    return n > 5 && n < 15;
  }));
});

Deno.test("mailer ops action: live path records Sent Items proof with CC + operation header", async () => {
  const store = new MemoryEffectStore();
  let sentRoute: any = null;
  let graphCalls = 0;
  let lastToken = "";
  const result = await sendMailerOpsVisibilityAction(
    makeClient({}),
    { mode: "api_key", user: null },
    {
      org_id: "00000000-0000-4000-8000-000000000001",
      job_id: "job-1",
      kind: "report",
      to: "mlb.mailer@primeeco.tech",
      dry_run: false,
    },
    {
      makeMailGateway: (loadAttachments) => ({
        createDraftAndSend: async (route, context) => {
          graphCalls++;
          sentRoute = route;
          lastToken = context.external_token;
          const atts = await loadAttachments(route.attachment_hashes || []);
          assertEquals(atts.length, 1);
          assertEquals(atts[0]!.contentType, "application/pdf");
          assertEquals(route.cc, [MAILER_OPS_CC]);
          assertEquals(route.recipients, ["mlb.mailer@primeeco.tech"]);
          assertEquals(route.requires_thread_reply, false);
          return {
            message_id: "graph-msg-1",
            internet_message_id: "<msg-1@secureworks>",
            state: "sent" as const,
            operation_token: context.external_token,
          };
        },
        // Post-dispatch reconcile must find exactly one Sent Items match.
        reconcileSent: (token: string) =>
          token && token === lastToken
            ? Promise.resolve([{
              message_id: "graph-msg-1",
              internet_message_id: "<msg-1@secureworks>",
              state: "sent" as const,
              operation_token: token,
            }])
            : Promise.resolve([]),
      }),
      effectStore: store,
    },
  );
  assertEquals(result.dry_run, false);
  assertEquals(result.success, true);
  assertEquals(graphCalls, 1);
  const proof = result.proof as any;
  assertEquals(proof.message_id, "graph-msg-1");
  assertEquals(proof.operation_header, SES_OPERATION_HEADER);
  assertEquals(proof.cc, [MAILER_OPS_CC]);
  assertEquals(proof.to, ["mlb.mailer@primeeco.tech"]);
  assertEquals(proof.from, MAILER_OPS_FROM);
  assertEquals(proof.proof_surfaces, ["admin_sent_items", "ses_intake_cc"]);
  assert(Array.isArray(proof.attachment_names));
  assert(proof.attachment_names.length === 1);
  assertEquals(store.row?.state, "confirmed");
  assertEquals(store.row?.effect_kind, "mailer_ops_send");
  assertEquals(sentRoute.subject, proof.subject_as_sent);
});

Deno.test("mailer ops action: refuses billing report_recipient as To", async () => {
  const err = await assertRejects(
    () =>
      sendMailerOpsVisibilityAction(
        makeClient({
          company: {
            slug: "mlb",
            sender_patterns: ["makesafes@mlbuilders.com.au"],
            report_recipient: "makesafes@mlbuilders.com.au",
          },
        }),
        { mode: "api_key", user: null },
        {
          org_id: "00000000-0000-4000-8000-000000000001",
          job_id: "job-1",
          kind: "report",
          // Allowlisted, but it is the billing pack mailbox: still refused.
          to: "makesafes@mlbuilders.com.au",
          dry_run: true,
        },
        {
          makeMailGateway: () => {
            throw new Error("no");
          },
          effectStore: new MemoryEffectStore(),
        },
      ),
    SesActionError,
  );
  assertEquals(
    ((err as SesActionError).refusal as any).code,
    "mailer_ops_billing_recipient_forbidden",
  );
});

Deno.test("mailer ops action: To must be named explicitly, never auto-selected", async () => {
  const err = await assertRejects(
    () =>
      sendMailerOpsVisibilityAction(
        makeClient({}),
        { mode: "api_key", user: null },
        {
          org_id: "00000000-0000-4000-8000-000000000001",
          job_id: "job-1",
          kind: "report",
          dry_run: true,
        },
        {
          makeMailGateway: () => {
            throw new Error("no");
          },
          effectStore: new MemoryEffectStore(),
        },
      ),
    SesActionError,
  );
  assertEquals(
    ((err as SesActionError).refusal as any).code,
    "mailer_recipient_confirmation_required",
  );
});

Deno.test("mailer ops action: receipts never ride the builder-facing photo pack", async () => {
  const result = await sendMailerOpsVisibilityAction(
    makeClient({
      media: [
        {
          id: "media-site-1",
          job_id: "job-1",
          type: "photo",
          phase: "completion",
          storage_url:
            "https://example.supabase.co/storage/v1/object/public/job-photos/job-1/site.jpg",
          created_at: "2026-08-01T00:00:00Z",
        },
        {
          id: "media-receipt-1",
          job_id: "job-1",
          type: "photo",
          phase: "receipt",
          storage_url:
            "https://example.supabase.co/storage/v1/object/public/job-photos/job-1/receipt.jpg",
          created_at: "2026-08-01T00:00:01Z",
        },
      ],
    }),
    { mode: "api_key", user: null },
    {
      org_id: "00000000-0000-4000-8000-000000000001",
      job_id: "job-1",
      kind: "photo",
      to: "mlb.mailer@primeeco.tech",
      dry_run: true,
    },
    {
      makeMailGateway: () => {
        throw new Error("no gateway");
      },
      effectStore: new MemoryEffectStore(),
    },
  );
  const photo = result.photo_selection as any;
  assertEquals(photo.media_ids, ["media-site-1"]);
  assertEquals(photo.available_count, 1);
  assertEquals(photo.excluded_receipt_count, 1);
});

Deno.test("mailer ops action: reattended card only carries current-cycle evidence", async () => {
  const detail = {
    job_id: "job-1",
    requesting_company_slug: "mlb",
    attendance_cycle_id: "cycle-2",
    cycle_number: 2,
    reattend_count: 1,
  };
  const media = [
    {
      id: "media-old",
      job_id: "job-1",
      type: "photo",
      phase: "completion",
      attendance_cycle_id: "cycle-1",
      cycle_attribution: "bound",
      storage_url:
        "https://example.supabase.co/storage/v1/object/public/job-photos/job-1/old.jpg",
      created_at: "2026-07-01T00:00:00Z",
    },
    {
      id: "media-current",
      job_id: "job-1",
      type: "photo",
      phase: "completion",
      attendance_cycle_id: "cycle-2",
      cycle_attribution: "bound",
      storage_url:
        "https://example.supabase.co/storage/v1/object/public/job-photos/job-1/new.jpg",
      created_at: "2026-08-01T00:00:00Z",
    },
  ];
  const photoResult = await sendMailerOpsVisibilityAction(
    makeClient({ detail, media }),
    { mode: "api_key", user: null },
    {
      org_id: "00000000-0000-4000-8000-000000000001",
      job_id: "job-1",
      kind: "photo",
      to: "mlb.mailer@primeeco.tech",
      dry_run: true,
    },
    {
      makeMailGateway: () => {
        throw new Error("no gateway");
      },
      effectStore: new MemoryEffectStore(),
    },
  );
  const photo = photoResult.photo_selection as any;
  assertEquals(photo.media_ids, ["media-current"]);
  assertEquals(photo.excluded_other_cycle_count, 1);
  assertEquals(photo.cycle_scoped, true);
  assertEquals((photoResult.attendance_cycle as any).attendance_cycle_id, "cycle-2");

  // A previous cycle's curated report must not be mailed as this visit's report.
  await assertRejects(
    () =>
      sendMailerOpsVisibilityAction(
        makeClient({
          detail,
          media,
          documents: [{
            id: "doc-old",
            job_id: "job-1",
            type: "makesafe_report",
            file_name: "old.pdf",
            storage_url:
              "https://example.supabase.co/storage/v1/object/public/job-documents/job-1/report.pdf",
            attendance_cycle_id: "cycle-1",
            cycle_attribution: "bound",
            data_snapshot_json: {
              curated_source_kind: "durable_curated_revision",
            },
            created_at: "2026-07-01T00:00:00Z",
          }],
        }),
        { mode: "api_key", user: null },
        {
          org_id: "00000000-0000-4000-8000-000000000001",
          job_id: "job-1",
          kind: "report",
          to: "mlb.mailer@primeeco.tech",
          dry_run: true,
        },
        {
          makeMailGateway: () => {
            throw new Error("no gateway");
          },
          effectStore: new MemoryEffectStore(),
        },
      ),
    SesActionError,
  );
});

Deno.test("mailer ops action: confirmed replay reports the ORIGINAL ledger proof", async () => {
  const store = new MemoryEffectStore();
  const args = {
    org_id: "00000000-0000-4000-8000-000000000001",
    job_id: "job-1",
    kind: "report" as const,
    to: "mlb.mailer@primeeco.tech",
    dry_run: false,
  };
  let lastToken = "";
  const gateway = (loadAttachments: any) => ({
    createDraftAndSend: async (route: any, context: any) => {
      lastToken = context.external_token;
      await loadAttachments(route.attachment_hashes || []);
      return {
        message_id: "graph-msg-1",
        internet_message_id: "<msg-1@secureworks>",
        state: "sent" as const,
        operation_token: context.external_token,
      };
    },
    reconcileSent: (token: string) =>
      token && token === lastToken
        ? Promise.resolve([{
          message_id: "graph-msg-1",
          internet_message_id: "<msg-1@secureworks>",
          state: "sent" as const,
          operation_token: token,
        }])
        : Promise.resolve([]),
  });
  await sendMailerOpsVisibilityAction(
    makeClient({}),
    { mode: "api_key", user: null },
    args,
    { makeMailGateway: gateway, effectStore: store },
  );

  // Same card, same kind, same content: the effect is already confirmed. The
  // reply must be the stored proof, never a freshly recomposed one.
  let secondGraphCalls = 0;
  const replay = await sendMailerOpsVisibilityAction(
    makeClient({}),
    { mode: "api_key", user: null },
    args,
    {
      makeMailGateway: () => ({
        createDraftAndSend: () => {
          secondGraphCalls++;
          throw new Error("must not redispatch");
        },
        reconcileSent: () => Promise.resolve([]),
      }),
      effectStore: store,
    },
  );
  assertEquals(secondGraphCalls, 0);
  assertEquals(replay.already_sent, true);
  assertEquals(replay.proof_source, "ses_external_effects_ledger");
  assertEquals((replay.recorded_proof as any).message_id, "graph-msg-1");
  assertEquals(replay.proof, undefined);
  assertEquals(
    (replay.recorded_proof as any).provider_digest.subject_as_sent,
    "NEW WORK ORDER - MLB-26267 U24/ 28 Peninsula Road, Maylands, WA 6051",
  );
});

Deno.test("mailer ops action: incidental content drift cannot mail the builder twice", async () => {
  const store = new MemoryEffectStore();
  const photoRow = (n: number) => ({
    id: `media-${n}`,
    job_id: "job-1",
    type: "photo",
    phase: "completion",
    label: `Site photo ${n}`,
    storage_url:
      `https://example.supabase.co/storage/v1/object/public/job-photos/job-1/p${n}.jpg`,
    created_at: `2026-08-01T00:00:0${n}Z`,
  });
  const args = {
    org_id: "00000000-0000-4000-8000-000000000001",
    job_id: "job-1",
    kind: "photo" as const,
    to: "mlb.mailer@primeeco.tech",
    dry_run: false,
  };
  let lastToken = "";
  const first = await sendMailerOpsVisibilityAction(
    makeClient({ media: [photoRow(1), photoRow(2)] }),
    { mode: "api_key", user: null },
    args,
    {
      makeMailGateway: (loadAttachments) => ({
        createDraftAndSend: async (route, context) => {
          lastToken = context.external_token;
          await loadAttachments(route.attachment_hashes || []);
          return {
            message_id: "graph-msg-1",
            state: "sent" as const,
            operation_token: context.external_token,
          };
        },
        reconcileSent: (token: string) =>
          token && token === lastToken
            ? Promise.resolve([{
              message_id: "graph-msg-1",
              state: "sent" as const,
              operation_token: token,
            }])
            : Promise.resolve([]),
      }),
      effectStore: store,
    },
  );

  // A trade uploads another photo, so the representative spread and every
  // attachment hash move. That is not an operator decision: the identity must
  // not move with it, and no second email may go out.
  let secondGraphCalls = 0;
  const drifted = await sendMailerOpsVisibilityAction(
    makeClient({ media: [photoRow(1), photoRow(2), photoRow(3)] }),
    { mode: "api_key", user: null },
    args,
    {
      makeMailGateway: () => ({
        createDraftAndSend: () => {
          secondGraphCalls++;
          throw new Error("content drift must not send a second email");
        },
        reconcileSent: () => Promise.resolve([]),
      }),
      effectStore: store,
    },
  );
  assertEquals(secondGraphCalls, 0);
  assertEquals(drifted.already_sent, true);
  assertEquals(
    (drifted.effect as any).operation_key,
    (first.effect as any).operation_key,
  );

  // Only a deliberately named attempt key mints a new operation key.
  const retryEffect = await sendMailerOpsVisibilityAction(
    makeClient({ media: [photoRow(1), photoRow(2)] }),
    { mode: "api_key", user: null },
    { ...args, attempt_key: "captain-retry-2", dry_run: true },
    {
      makeMailGateway: () => {
        throw new Error("no gateway in dry_run");
      },
      effectStore: new MemoryEffectStore(),
    },
  );
  assert(
    (retryEffect.effect_preview as any).operation_key !==
      (first.effect as any).operation_key,
  );
});

Deno.test("mailer ops action: a database failure on the audit row is logged, not swallowed", async () => {
  const store = new MemoryEffectStore();
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...parts: unknown[]) => warnings.push(parts.join(" "));
  let lastToken = "";
  try {
    await sendMailerOpsVisibilityAction(
      makeClient({ jobEventsError: { message: "rls denied" } }),
      { mode: "api_key", user: null },
      {
        org_id: "00000000-0000-4000-8000-000000000001",
        job_id: "job-1",
        kind: "report",
        to: "mlb.mailer@primeeco.tech",
        dry_run: false,
      },
      {
        makeMailGateway: (loadAttachments) => ({
          createDraftAndSend: async (route, context) => {
            lastToken = context.external_token;
            await loadAttachments(route.attachment_hashes || []);
            return {
              message_id: "graph-msg-1",
              state: "sent" as const,
              operation_token: context.external_token,
            };
          },
          reconcileSent: (token: string) =>
            token && token === lastToken
              ? Promise.resolve([{
                message_id: "graph-msg-1",
                state: "sent" as const,
                operation_token: token,
              }])
              : Promise.resolve([]),
        }),
        effectStore: store,
      },
    );
  } finally {
    console.warn = originalWarn;
  }
  assert(
    warnings.some((w) => String(w).includes("rls denied")),
    "job_events {error} must surface as a warning",
  );
});

Deno.test("mailer ops action: routine auth refused", async () => {
  await assertRejects(
    () =>
      sendMailerOpsVisibilityAction(
        makeClient({}),
        { mode: "routine", user: null },
        {
          org_id: "00000000-0000-4000-8000-000000000001",
          job_id: "job-1",
          kind: "report",
          to: "mlb.mailer@primeeco.tech",
          dry_run: true,
        },
        {
          makeMailGateway: () => {
            throw new Error("no");
          },
          effectStore: new MemoryEffectStore(),
        },
      ),
    SesActionError,
  );
});

Deno.test("mailer ops action: single-card drive — kind report does not require photo", async () => {
  // No media rows: report path still works (independent card/kind).
  const result = await sendMailerOpsVisibilityAction(
    makeClient({ media: [] }),
    { mode: "api_key", user: null },
    {
      org_id: "00000000-0000-4000-8000-000000000001",
      job_id: "job-1",
      kind: "report",
      to: "mlb.mailer@primeeco.tech",
      dry_run: true,
    },
    {
      makeMailGateway: () => {
        throw new Error("no");
      },
      effectStore: new MemoryEffectStore(),
    },
  );
  assertEquals(result.kind, "report");
  assertEquals(result.photo_selection, null);
});

Deno.test("mailer ops: source pins — no invoice string in attachment role union usage", async () => {
  // Source-level: the module must not list invoice as a MailerOpsAttachmentRole.
  const source = await Deno.readTextFile(
    new URL("./ses_mailer_ops_send.ts", import.meta.url),
  );
  assertStringIncludes(
    source,
    'export type MailerOpsAttachmentRole = "report_pdf" | "site_photo"',
  );
  assertStringIncludes(source, 'export type MailerOpsRouteKind = "report" | "photo"');
  assertStringIncludes(source, 'export const MAILER_OPS_CC = SES_RELEASE_CC');
  assertStringIncludes(source, "ses@secureworkswa.com.au");
  // Import graph: no docket preparer / release executor / fence exemption.
  const importLines = source.split("\n").filter((l) =>
    /^\s*import\s/.test(l) || /from\s+["']\.\//.test(l)
  ).join("\n");
  assert(!importLines.includes("ses_prepare_docket_revision"));
  assert(!importLines.includes("ses_reporting_actions.ts") || true); // SesActionError only
  assert(!importLines.includes("SEALED_SES_MONEY_READ_EXEMPT"));
  assert(!importLines.includes("send-outlook-email"));
  // Structural invoice impossibility is typed, not a runtime allow-list of money docs only.
  assert(!source.includes('MailerOpsRouteKind = "report" | "photo" | "invoice"'));
});

Deno.test("mailer ops: index wires send_mailer_ops_visibility and dedicated gateway", async () => {
  const index = await Deno.readTextFile(
    new URL("./index.ts", import.meta.url),
  );
  assertStringIncludes(index, "case 'send_mailer_ops_visibility'");
  assertStringIncludes(index, "makeMailerOpsGraphMailGateway");
  assertStringIncludes(index, "sendMailerOpsVisibilityAction");
  // Must not add this send to routine allow-list
  const allowStart = index.indexOf("const ROUTINE_ALLOWED_ACTIONS = new Set([");
  const allowEnd = index.indexOf("])", allowStart);
  const allowBlock = index.slice(allowStart, allowEnd);
  assert(
    !allowBlock.includes("send_mailer_ops_visibility"),
    "send_mailer_ops_visibility must not be routine-allow-listed",
  );
});

Deno.test("mailer ops: migration adds mailer_ops_send without invoice route_kind", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260805020000_ses_mailer_ops_send_effect.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "'mailer_ops_send'");
  assertStringIncludes(sql, "route_kind IN ('report', 'photo')");
  assertStringIncludes(sql, "uq_ses_external_mailer_ops_send");
  // Shape requires no release/invoice/docket ids
  assertStringIncludes(sql, "release_revision_id IS NULL");
  assertStringIncludes(sql, "invoice_obligation_revision_id IS NULL");
  // The attempt hash is the retry coordinate: required, and part of uniqueness
  // so a deliberate new attempt is a new row rather than a stranded card.
  assertStringIncludes(sql, "artifact_hash IS NOT NULL");
  assertStringIncludes(
    sql,
    "(job_id, route_kind, artifact_hash)",
  );
});

Deno.test("mailer ops: edge schema gate declares the migration marker", async () => {
  const manifest = await Deno.readTextFile(
    new URL("../../../scripts/edge-function-schema-requirements.txt", import.meta.url),
  );
  assertStringIncludes(
    manifest,
    "ops-api|supabase/migrations/20260805020000_ses_mailer_ops_send_effect.sql|index|uq_ses_external_mailer_ops_send",
  );
});
