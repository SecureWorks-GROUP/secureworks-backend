// deno-lint-ignore-file no-import-prefix no-explicit-any require-await

import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ensureIntakeWorkOrderEvidence,
  settleApprovedIntakeDraft,
  SOURCE_PERSIST_RECOVERY_NOTIFICATION_SUPPRESSION,
} from "./makesafe_intake_settlement.ts";

const noIdentityRefresh = async () => null;

function client(existing: any[] = [], insertError: any = null) {
  const inserts: any[] = [];
  let nextId = 1;
  const query: any = {
    select() {
      return query;
    },
    in() {
      return query;
    },
    eq() {
      return query;
    },
    is() {
      return query;
    },
    limit() {
      return Promise.resolve({ data: existing, error: null });
    },
    then(resolve: (value: any) => unknown) {
      return resolve({ data: existing, error: null });
    },
  };
  return {
    inserts,
    client: {
      from() {
        return {
          select() {
            return query;
          },
          insert(row: any) {
            inserts.push(row);
            const inserted = { id: `doc-${nextId++}`, ...row };
            return {
              select() {
                return {
                  single() {
                    if (insertError) {
                      return Promise.resolve({
                        data: null,
                        error: insertError,
                      });
                    }
                    existing.push(inserted);
                    return Promise.resolve({ data: inserted, error: null });
                  },
                };
              },
            };
          },
        };
      },
    },
  };
}

Deno.test("work-order evidence continuation fans every source PDF to every minted job idempotently", async () => {
  const db = client([
    {
      job_id: "job-1",
      storage_url: "storage/work-order.pdf",
      pdf_url: "storage/work-order.pdf",
    },
  ]);
  await ensureIntakeWorkOrderEvidence(
    db.client,
    ["job-1", "job-2", "job-2"],
    [{
      file_name: "work-order.pdf",
      storage_url: "storage/work-order.pdf",
    }],
    {},
    { refreshIdentity: noIdentityRefresh as any },
  );

  assertEquals(db.inserts, [{
    job_id: "job-2",
    type: "work_order",
    file_name: "work-order.pdf",
    storage_url: "storage/work-order.pdf",
    pdf_url: "storage/work-order.pdf",
    visible_to_trades: true,
  }]);
});

Deno.test("work-order evidence continuation remains retryable after an insert failure", async () => {
  const db = client([], { message: "storage write failed" });
  await assertRejects(
    () =>
      ensureIntakeWorkOrderEvidence(
        db.client,
        ["job-1"],
        [{ pdf_url: "storage/work-order.pdf" }],
        {},
      ),
    Error,
    "work-order evidence attach failed",
  );
});

Deno.test("work-order evidence continuation adopts a concurrent insert winner", async () => {
  const winner = {
    id: "doc-winner",
    job_id: "job-1",
    type: "work_order",
    file_name: "work-order.pdf",
    storage_url: "storage/work-order.pdf",
    pdf_url: "storage/work-order.pdf",
  };
  let refreshes = 0;
  const makeRead = (initial: boolean) => {
    const query: any = {
      select() {
        return query;
      },
      in() {
        return query;
      },
      eq() {
        return query;
      },
      is() {
        return query;
      },
      limit() {
        return Promise.resolve({ data: [winner], error: null });
      },
      then(resolve: (value: any) => unknown) {
        return resolve({ data: initial ? [] : [winner], error: null });
      },
    };
    return query;
  };
  let reads = 0;
  const raceClient = {
    from(table: string) {
      assertEquals(table, "job_documents");
      return {
        select() {
          reads += 1;
          return makeRead(reads === 1);
        },
        insert() {
          return {
            select() {
              return {
                single() {
                  return Promise.resolve({
                    data: null,
                    error: {
                      code: "23505",
                      message:
                        'duplicate key value violates unique constraint "ux_job_documents_makesafe_attach_key"',
                    },
                  });
                },
              };
            },
          };
        },
      };
    },
  };

  await ensureIntakeWorkOrderEvidence(
    raceClient,
    ["job-1"],
    [{
      file_name: "work-order.pdf",
      storage_url: "storage/work-order.pdf",
    }],
    {},
    {
      refreshIdentity: async () => {
        refreshes += 1;
        return null;
      },
    },
  );

  assertEquals(refreshes, 1);
});

Deno.test("settlement repairs legacy evidence but only explicit mint authority can notify", async () => {
  const notifications: string[] = [];
  const mintRows: any[] = [];
  const db = client([]);
  const settlementClient: any = db.client;
  const originalFrom = settlementClient.from;
  settlementClient.from = (table: string) => {
    if (table === "makesafe_intake_job_mints") {
      const query: any = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        order() {
          return Promise.resolve({ data: mintRows, error: null });
        },
      };
      return query;
    }
    return originalFrom(table);
  };

  const result = await settleApprovedIntakeDraft(settlementClient, {
    draftId: "draft-legacy",
    approvedJobId: "legacy-job",
    attachments: [{ pdf_url: "storage/work-order.pdf" }],
    extraction: { deterministic_intake: true },
    refreshIdentity: noIdentityRefresh as any,
    notify: async (input) => {
      notifications.push(input.jobId);
      return { accepted: true, reason: "accepted", auditId: "audit-1" };
    },
  });

  assertEquals(result.jobIds, ["legacy-job"]);
  assertEquals(result.notificationJobIds, []);
  assertEquals(notifications, []);
  assertEquals(db.inserts[0].job_id, "legacy-job");
});

Deno.test("an explicit no-send settlement records suppression without calling the notifier", async () => {
  const mint = {
    id: "mint-no-send",
    draft_id: "draft-no-send",
    mint_role: "primary",
    case_id: "case-no-send",
    source_post_ids: ["source-no-send"],
    job_id: "job-no-send",
    state: "minted",
    evidence_attached_at: "2026-08-04T00:00:00.000Z",
    board_observed_at: "2026-08-04T00:00:00.000Z",
    notification_accepted_at: null,
    last_error: null,
  };
  let notifications = 0;
  let boardProofs = 0;
  const settlementClient: any = {
    from(table: string) {
      if (table === "job_documents") {
        const query: any = {
          select() {
            return query;
          },
          in() {
            return query;
          },
          eq() {
            return query;
          },
          is() {
            return Promise.resolve({
              data: [{
                job_id: "job-no-send",
                storage_url: "fixture-object",
                pdf_url: null,
              }],
              error: null,
            });
          },
        };
        return query;
      }
      if (table === "makesafe_intake_cases") {
        const query: any = {
          select() {
            return query;
          },
          in() {
            return Promise.resolve({
              data: [{
                id: "case-no-send",
                state: "confirmed_live_job",
                job_id: "job-no-send",
                blocked_reasons: [],
              }],
              error: null,
            });
          },
        };
        return query;
      }
      if (table !== "makesafe_intake_job_mints") {
        throw new Error(`unexpected table ${table}`);
      }
      const query: any = {
        payload: null as any,
        select() {
          return query;
        },
        eq() {
          return query;
        },
        neq() {
          return query;
        },
        is() {
          return query;
        },
        order() {
          return Promise.resolve({ data: [mint], error: null });
        },
        update(payload: any) {
          query.payload = payload;
          return query;
        },
        maybeSingle() {
          Object.assign(mint, query.payload);
          return Promise.resolve({ data: { id: mint.id }, error: null });
        },
      };
      return query;
    },
  };

  const result = await settleApprovedIntakeDraft(settlementClient, {
    draftId: "draft-no-send",
    approvedJobId: "job-no-send",
    attachments: [{
      file_name: "work-order.pdf",
      storage_url: "fixture-object",
    }],
    extraction: { deterministic_intake: true },
    notificationSuppressionReason:
      SOURCE_PERSIST_RECOVERY_NOTIFICATION_SUPPRESSION,
    verifyNotificationSuppression: async () => {
      boardProofs++;
      return true;
    },
    notify: async () => {
      notifications++;
      return { accepted: true, reason: "accepted", auditId: "must-not-exist" };
    },
  });

  assertEquals(notifications, 0);
  assertEquals(boardProofs, 1);
  assertEquals(result.notificationJobIds, ["job-no-send"]);
  assertEquals(result.notificationsAccepted, 0);
  assertEquals(mint.state, "settled");
  assertEquals(mint.notification_accepted_at, null);
  assertEquals(
    mint.last_error,
    `notification_suppressed:${SOURCE_PERSIST_RECOVERY_NOTIFICATION_SUPPRESSION}`,
  );

  Object.assign(mint, {
    state: "minted",
    notification_accepted_at: null,
    last_error: null,
  });
  await assertRejects(
    () =>
      settleApprovedIntakeDraft(settlementClient, {
        draftId: "draft-no-send",
        approvedJobId: "job-no-send",
        attachments: [{
          file_name: "work-order.pdf",
          storage_url: "fixture-object",
        }],
        extraction: { deterministic_intake: true },
        notificationSuppressionReason:
          SOURCE_PERSIST_RECOVERY_NOTIFICATION_SUPPRESSION,
        notify: async () => {
          notifications++;
          return {
            accepted: true,
            reason: "accepted",
            auditId: "must-not-exist",
          };
        },
      }),
    Error,
    "requires canonical board proof",
  );
  assertEquals(notifications, 0);
});

Deno.test("settlement refuses missing or unbound required mint roles", async () => {
  const mintRows: any[] = [{
    id: "mint-primary",
    draft_id: "draft-split",
    mint_role: "primary",
    case_id: "case-1",
    source_post_ids: ["post-1"],
    job_id: "job-1",
    state: "minted",
    evidence_attached_at: null,
    board_observed_at: null,
    notification_accepted_at: null,
  }];
  const settlementClient: any = {
    from(table: string) {
      if (table !== "makesafe_intake_job_mints") {
        throw new Error(`unexpected table ${table}`);
      }
      const query: any = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        order() {
          return Promise.resolve({ data: mintRows, error: null });
        },
      };
      return query;
    },
  };

  await assertRejects(
    () =>
      settleApprovedIntakeDraft(settlementClient, {
        draftId: "draft-split",
        approvedJobId: "job-1",
        attachments: [{ pdf_url: "storage/work-order.pdf" }],
        extraction: { deterministic_intake: true },
        requiredMintRoles: ["primary", "secondary_report"],
        notify: async () => ({
          accepted: true,
          reason: "accepted",
          auditId: "audit-1",
        }),
      }),
    Error,
    "lacks required mint authority: secondary_report",
  );

  mintRows.push({
    ...mintRows[0],
    id: "mint-secondary",
    mint_role: "secondary_report",
    job_id: null,
  });
  await assertRejects(
    () =>
      settleApprovedIntakeDraft(settlementClient, {
        draftId: "draft-split",
        approvedJobId: "job-1",
        attachments: [{ pdf_url: "storage/work-order.pdf" }],
        extraction: { deterministic_intake: true },
        requiredMintRoles: ["primary", "secondary_report"],
        notify: async () => ({
          accepted: true,
          reason: "accepted",
          auditId: "audit-1",
        }),
      }),
    Error,
    "unbound mint authority: secondary_report",
  );
});

Deno.test("a stale failed settlement cannot regress accepted authority", async () => {
  const pendingMint = {
    id: "mint-1",
    draft_id: "draft-1",
    mint_role: "primary",
    case_id: "case-1",
    source_post_ids: ["post-1"],
    job_id: "job-1",
    state: "minted",
    evidence_attached_at: null,
    board_observed_at: null,
    notification_accepted_at: null,
  };
  const settledMint = {
    ...pendingMint,
    state: "settled",
    notification_accepted_at: "2026-07-31T00:00:00.000Z",
  };
  let mintReads = 0;
  const evidence = client([]);
  const originalFrom: any = evidence.client.from;
  const settlementClient: any = evidence.client;
  settlementClient.from = (table: string) => {
    if (table !== "makesafe_intake_job_mints") return originalFrom(table);
    let updating = false;
    const query: any = {
      update() {
        updating = true;
        return query;
      },
      select() {
        return query;
      },
      eq() {
        return query;
      },
      neq() {
        return query;
      },
      is() {
        return query;
      },
      order() {
        mintReads++;
        return Promise.resolve({
          data: mintReads === 1 ? [pendingMint] : [settledMint],
          error: null,
        });
      },
      maybeSingle() {
        assertEquals(updating, true);
        return Promise.resolve({ data: null, error: null });
      },
    };
    return query;
  };

  const result = await settleApprovedIntakeDraft(settlementClient, {
    draftId: "draft-1",
    approvedJobId: "job-1",
    attachments: [{ pdf_url: "storage/work-order.pdf" }],
    extraction: { deterministic_intake: true },
    requiredMintRoles: ["primary"],
    refreshIdentity: noIdentityRefresh as any,
    notify: async () => ({
      accepted: false,
      reason: "stale transport failure",
      auditId: "audit-1",
    }),
  });

  assertEquals(result.notificationsAccepted, 1);
  assertEquals(mintReads, 2);
});

// ── Intake case → job binding at the shared settlement seam ─────────────────
//
// The deterministic runtime binds `makesafe_intake_cases.job_id` only on the
// runs it advances itself. Every draft a HUMAN approves from the review queue —
// which since the 2026-08-28 supervised-repair ruling is every repair-family
// draft — reaches its job through `settleApprovedIntakeDraft` instead, and a
// case left unbound is a caseless card that `prepare_ses_docket_revision`
// refuses with `spine_missing_source` / `spine_missing_lineage`.

function caseBindingClient(input: {
  mints: any[];
  cases: any[];
  jobs: any[];
  draftMissingFields?: string[];
}) {
  const updates: any[] = [];
  return {
    updates,
    client: {
      from(table: string) {
        if (table === "makesafe_intake_job_mints") {
          let payload: any = null;
          const query: any = {
            select: () => query,
            eq: () => query,
            neq: () => query,
            is: () => query,
            update(next: any) {
              payload = next;
              return query;
            },
            maybeSingle() {
              Object.assign(input.mints[0], payload);
              return Promise.resolve({
                data: { id: input.mints[0].id },
                error: null,
              });
            },
            order: () => Promise.resolve({ data: input.mints, error: null }),
          };
          return query;
        }
        if (table === "job_documents") {
          const query: any = {
            select: () => query,
            in: () => query,
            eq: () => query,
            is: () =>
              Promise.resolve({
                data: input.mints.map((mint: any) => ({
                  job_id: mint.job_id,
                  storage_url: "storage/work-order.pdf",
                  pdf_url: "storage/work-order.pdf",
                })),
                error: null,
              }),
          };
          return query;
        }
        if (table === "jobs") {
          const query: any = {
            select: () => query,
            in: () => Promise.resolve({ data: input.jobs, error: null }),
          };
          return query;
        }
        if (table === "makesafe_intake_drafts") {
          const query: any = {
            select: () => query,
            eq: () => query,
            maybeSingle: () =>
              Promise.resolve({
                data: { missing_fields: input.draftMissingFields || [] },
                error: null,
              }),
          };
          return query;
        }
        if (table === "makesafe_intake_cases") {
          let payload: any = null;
          let targetId: string | null = null;
          let requireUnbound = false;
          const query: any = {
            select: () => query,
            in: () => Promise.resolve({ data: input.cases, error: null }),
            update(next: any) {
              payload = next;
              return query;
            },
            eq(_column: string, value: string) {
              targetId = value;
              return query;
            },
            is() {
              requireUnbound = true;
              return query;
            },
            maybeSingle() {
              const row = input.cases.find((c: any) => c.id === targetId);
              if (!row || (requireUnbound && row.job_id)) {
                return Promise.resolve({ data: null, error: null });
              }
              Object.assign(row, payload);
              updates.push({ id: targetId, ...payload });
              return Promise.resolve({ data: { id: targetId }, error: null });
            },
          };
          return query;
        }
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
}

function repairMint(overrides: Record<string, unknown> = {}) {
  return {
    id: "mint-repair",
    draft_id: "draft-repair",
    mint_role: "primary",
    case_id: "case-repair",
    source_post_ids: ["post-repair"],
    job_id: "job-repair",
    state: "minted",
    evidence_attached_at: null,
    board_observed_at: null,
    notification_accepted_at: null,
    ...overrides,
  };
}

const settleRepair = (
  client: any,
  approval: { actor?: string; provenance?: "deterministic" | "human" } = {},
) =>
  settleApprovedIntakeDraft(client, {
    draftId: "draft-repair",
    approvedJobId: "job-repair",
    attachments: [{
      file_name: "work-order.pdf",
      storage_url: "storage/work-order.pdf",
    }],
    extraction: { deterministic_intake: true },
    refreshIdentity: noIdentityRefresh as any,
    ...(approval.actor ? { caseBindingActor: approval.actor } : {}),
    ...(approval.provenance
      ? { caseBindingProvenance: approval.provenance }
      : {}),
    notify: async () => ({
      accepted: true,
      reason: "accepted",
      auditId: "audit-repair",
    }),
  });

Deno.test("a parked repair draft approved by a human leaves its intake case bound to the minted job", async () => {
  const db = caseBindingClient({
    mints: [repairMint()],
    cases: [{
      id: "case-repair",
      state: "exception",
      reason_code: "awaiting_job_creation",
      job_id: null,
      blocked_reasons: [],
    }],
    jobs: [{ id: "job-repair", type: "repair" }],
  });

  await settleRepair(db.client);

  assertEquals(db.updates.length, 1);
  assertEquals(db.updates[0].job_id, "job-repair");
  // exception -> confirmed_live_job is the one promotion direction the census
  // invariants and the case transition table both allow.
  assertEquals(db.updates[0].state, "confirmed_live_job");
  assertEquals(db.updates[0].reason_code, null);
});

// The REAL parked shape: `makesafe_intake_cases_exception_shape_check` forces
// `cardinality(blocked_reasons) = 0` on an unbound case, so a parked row can
// never carry them however blocked its plan was. The coordinate that survives
// the park is the draft's `missing_fields`, which the deterministic runtime
// writes from `plan.blockedReasons` — losing it would silently promote a
// blocked_live_job plan to confirmed and drop the card off the gap-fill queue
// and the intake exception desk.
Deno.test("a parked blocked_live_job plan binds as blocked, with its reasons recovered from the draft", async () => {
  const db = caseBindingClient({
    mints: [repairMint()],
    cases: [{
      id: "case-repair",
      state: "exception",
      reason_code: "awaiting_job_creation",
      job_id: null,
      blocked_reasons: [],
    }],
    jobs: [{ id: "job-repair", type: "repair" }],
    draftMissingFields: ["missing:portal_evidence", "missing:report_pdf"],
  });

  await settleRepair(db.client);

  assertEquals(db.updates.length, 1);
  assertEquals(db.updates[0].job_id, "job-repair");
  assertEquals(db.updates[0].state, "blocked_live_job");
  assertEquals(db.updates[0].blocked_reasons, [
    "missing:portal_evidence",
    "missing:report_pdf",
  ]);
  assertEquals(db.updates[0].reason_code, null);
});

Deno.test("draft field names the case CHECK would reject never reach the blocked set", async () => {
  const db = caseBindingClient({
    mints: [repairMint()],
    cases: [{
      id: "case-repair",
      state: "exception",
      reason_code: "awaiting_job_creation",
      job_id: null,
      blocked_reasons: [],
    }],
    jobs: [{ id: "job-repair", type: "repair" }],
    draftMissingFields: ["Missing Portal Evidence", "  "],
  });

  await settleRepair(db.client);

  assertEquals(db.updates.length, 1);
  assertEquals(db.updates[0].state, "confirmed_live_job");
  assertEquals(db.updates[0].blocked_reasons, []);
});

Deno.test("a Captain approval is attributed to the human in the case-event ledger", async () => {
  const db = caseBindingClient({
    mints: [repairMint()],
    cases: [{
      id: "case-repair",
      state: "exception",
      reason_code: "awaiting_job_creation",
      job_id: null,
      blocked_reasons: [],
    }],
    jobs: [{ id: "job-repair", type: "repair" }],
  });

  await settleRepair(db.client, {
    actor: "captain@secureworkswa.com.au",
    provenance: "human",
  });

  assertEquals(db.updates.length, 1);
  assertEquals(db.updates[0].last_decision_provenance, "human");
  assertEquals(
    db.updates[0].last_decision_actor,
    "captain@secureworkswa.com.au",
  );
});

Deno.test("settlement never re-points an already bound intake case", async () => {
  const db = caseBindingClient({
    mints: [repairMint()],
    cases: [{
      id: "case-repair",
      state: "confirmed_live_job",
      job_id: "job-earlier",
      blocked_reasons: [],
    }],
    jobs: [{ id: "job-repair", type: "repair" }],
  });

  await settleRepair(db.client);

  assertEquals(db.updates, []);
});

Deno.test("a restoration job is left unbound: the case-write trigger admits make-safe and repair only", async () => {
  // `enforce_makesafe_intake_case_write` RAISES for any other job type, so
  // attempting the link would fail the whole settlement for that family.
  const db = caseBindingClient({
    mints: [repairMint()],
    cases: [{
      id: "case-repair",
      state: "exception",
      reason_code: "awaiting_job_creation",
      job_id: null,
      blocked_reasons: [],
    }],
    jobs: [{ id: "job-repair", type: "insurance" }],
  });

  await settleRepair(db.client);

  assertEquals(db.updates, []);
});

// A repair draft can now wait days in the review queue for its human tick, and
// the case can move to a different reason-coded exception in that window. This
// binding was written only for the `awaiting_job_creation` park; promoting any
// other reason clears an exception nobody resolved, and a `cancellation` case
// gaining a job_id RAISES `makesafe_intake_cases_cancellation_no_job_check`
// AFTER the job has already minted, which every re-approval then reproduces.
Deno.test("a case that became a cancellation while the draft waited is skipped, not promoted", async () => {
  const db = caseBindingClient({
    mints: [repairMint()],
    cases: [{
      id: "case-repair",
      state: "exception",
      reason_code: "cancellation",
      job_id: null,
      blocked_reasons: [],
    }],
    jobs: [{ id: "job-repair", type: "repair" }],
  });

  await settleRepair(db.client);

  assertEquals(db.updates, []);
});

Deno.test("a case carrying any other exception reason keeps that reason", async () => {
  const db = caseBindingClient({
    mints: [repairMint()],
    cases: [{
      id: "case-repair",
      state: "exception",
      reason_code: "ambiguous_scope",
      job_id: null,
      blocked_reasons: [],
    }],
    jobs: [{ id: "job-repair", type: "repair" }],
  });

  await settleRepair(db.client);

  assertEquals(db.updates, []);
});
