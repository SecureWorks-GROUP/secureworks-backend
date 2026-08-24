// deno-lint-ignore-file no-explicit-any no-import-prefix
/**
 * SWMS-26832 class — bundled sibling closeout terminal-proof recorder.
 *
 * Anchor: Peppermint Way SWMS-26832 was billed+sent under sibling SWMS-26837
 * INV-0835 PAID. U2 reconcile never writes a proof (no OWN raised invoice).
 * These tests pin the planner: bundled path accepts reciprocal binding +
 * sibling PAID + pack-sent triage; neighbours stay refused.
 *
 * Adversarial regressions (PR 752 review):
 *   A — superseded same-kind proof must not wall a covering re-attend write
 *   B — caller proven_at that is not an observed instant is refused
 *   C — own path must not elevate a triage-only freeform note into closeout
 */
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  planMakesafeTerminalProofRecord,
  RecordTerminalProofConflictError,
  RecordTerminalProofRequestError,
  recordMakesafeTerminalProofAction,
  type RecordTerminalProofObservation,
} from "./makesafe_record_terminal_proof.ts";
import { deriveSesStageV2 } from "./ses_stage_engine_v2.ts";
import { makesafeAttendanceCycleSetHash } from "./makesafe_terminal_proof.ts";

const JOB = "c3afc061-0d4a-43ff-8309-0b8b512e307a";
const SIBLING = "02f614a4-09a7-422e-9381-c89a44aceccd";
const CYCLE = "8360be6f-390d-4205-a711-6d7730bb8085";
const CYCLE_2 = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BINDING = "7dcf8954-5f8c-412b-898e-bc92987e44fc";
const REVERSE = "a2ebb22e-6f46-463d-87c8-7e7ec71cd399";
const BUNDLE = "1cd35292-1eb7-438f-bf6e-8dbcdf3fb135";
const ORG = "00000000-0000-0000-0000-000000000001";
const INV = "3be46700-4d5d-4b91-b96e-8baf43ac9d7c";

const SWMS_26832_LEGACY_NOTE =
  "BUNDLED into SWMS-26837 temp-fence make-safe (one WO) - no separate invoice; " +
  "labour+report+SWMS covered under INV-0835. Sent to bunbury@ in the MLB-26393 " +
  "claim email 2026-06-30T08:32:20Z.";

const CANONICAL_PACK_SENT =
  "MAKESAFE_PACK_SENT | main | - | to=bunbury@mlbuilders.com.au | 2026-06-30T08:32:01Z | msgid=abc | bundled under INV-0835 on SWMS-26837";

function baseObservation(
  over: Partial<RecordTerminalProofObservation> = {},
): RecordTerminalProofObservation {
  return {
    job: {
      id: JOB,
      org_id: ORG,
      job_number: "SWMS-26832",
      type: "makesafe",
      status: "invoiced",
    },
    cycle_ids: [CYCLE],
    existing_proofs: [],
    own_raised_invoices: [],
    pack_sent_events: [{
      id: "evt-bundled",
      created_at: "2026-06-30T08:32:21.612Z",
      text: SWMS_26832_LEGACY_NOTE,
    }],
    pack_sent_at: null,
    outbound_bindings: [{
      id: BINDING,
      job_id: JOB,
      sibling_job_id: SIBLING,
      bundle_id: BUNDLE,
      org_id: ORG,
      state: "bound",
      recorded_at: "2026-07-28T04:00:00Z",
    }],
    reverse_bindings: [{
      id: REVERSE,
      job_id: SIBLING,
      sibling_job_id: JOB,
      bundle_id: BUNDLE,
      org_id: ORG,
      state: "bound",
      recorded_at: "2026-07-28T04:00:00Z",
    }],
    sibling_raised_invoices: [{
      id: INV,
      job_id: SIBLING,
      invoice_number: "INV-0835",
      status: "PAID",
      invoice_type: "ACCREC",
      invoice_date: "2026-06-30",
      fully_paid_on: "2026-07-02",
    }],
    ...over,
  };
}

Deno.test("SWMS-26832 bundled path: reciprocal binding + sibling PAID + bundled send note plans a proof", async () => {
  const plan = await planMakesafeTerminalProofRecord({
    observation: baseObservation(),
    proven_by: "ses-codefix:swms-26832-bundled-closeout",
  });
  assertEquals(plan.path, "sibling_bundle");
  assertEquals(plan.job_id, JOB);
  assertEquals(plan.sibling_job_id, SIBLING);
  assertEquals(plan.sibling_invoice_number, "INV-0835");
  assertEquals(plan.binding_revision_id, BINDING);
  assertEquals(plan.reverse_binding_revision_id, REVERSE);
  assertEquals(plan.proven_at, "2026-06-30T08:32:21.612Z");
  assert(plan.attendance_cycle_set_hash.startsWith("sha256:"));
  assert(plan.evidence_refs.some((r) => r.includes(BINDING)));
  assert(plan.evidence_refs.some((r) => r.includes("INV-0835")));
  // Photo claim is deliberately NOT required — missing photo must not wall closeout.
  assertEquals(
    plan.evidence_refs.some((r) => r.includes("photo")),
    false,
  );
});

Deno.test("canonical MAKESAFE_PACK_SENT marker also satisfies pack-sent evidence", async () => {
  const plan = await planMakesafeTerminalProofRecord({
    observation: baseObservation({
      pack_sent_events: [{
        id: "evt-canonical",
        created_at: "2026-06-30T08:32:01Z",
        text: CANONICAL_PACK_SENT,
      }],
    }),
    proven_by: "operator",
  });
  assertEquals(plan.path, "sibling_bundle");
  assertEquals(plan.proven_at, "2026-06-30T08:32:01.000Z");
});

Deno.test("missing reciprocal binding refuses", async () => {
  const err = await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation({ reverse_bindings: [] }),
        proven_by: "operator",
      }),
    RecordTerminalProofConflictError,
  ) as RecordTerminalProofConflictError;
  assertEquals(err.code, "sibling_binding_not_bidirectional");
});

Deno.test("missing sibling raised invoice refuses", async () => {
  const err = await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation({ sibling_raised_invoices: [] }),
        proven_by: "operator",
      }),
    RecordTerminalProofConflictError,
  ) as RecordTerminalProofConflictError;
  assertEquals(err.code, "sibling_raised_invoice_missing");
});

Deno.test("DRAFT sibling invoice never funds a closeout proof", async () => {
  const err = await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation({
          sibling_raised_invoices: [{
            id: INV,
            job_id: SIBLING,
            invoice_number: "INV-0835",
            status: "DRAFT",
            invoice_type: "ACCREC",
          }],
        }),
        proven_by: "operator",
      }),
    RecordTerminalProofConflictError,
  ) as RecordTerminalProofConflictError;
  assertEquals(err.code, "sibling_raised_invoice_missing");
});

Deno.test("no pack-sent evidence refuses", async () => {
  const err = await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation({
          pack_sent_events: [{
            id: "evt-noise",
            created_at: "2026-06-30T08:00:00Z",
            text: "crew attended, awaiting report",
          }],
          pack_sent_at: null,
        }),
        proven_by: "operator",
      }),
    RecordTerminalProofConflictError,
  ) as RecordTerminalProofConflictError;
  assertEquals(err.code, "pack_send_evidence_missing");
});

Deno.test("own raised invoice on the claiming card refuses the bundled path", async () => {
  const err = await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation({
          own_raised_invoices: [{
            id: "own-inv",
            job_id: JOB,
            invoice_number: "INV-9999",
            status: "AUTHORISED",
            invoice_type: "ACCREC",
          }],
        }),
        proven_by: "operator",
        sibling_job_id: SIBLING,
      }),
    RecordTerminalProofConflictError,
  ) as RecordTerminalProofConflictError;
  assertEquals(err.code, "own_raised_invoice_present");
});

Deno.test("own raised invoice path works with canonical pack-sent evidence", async () => {
  const plan = await planMakesafeTerminalProofRecord({
    observation: baseObservation({
      own_raised_invoices: [{
        id: "own-inv",
        job_id: JOB,
        invoice_number: "INV-9999",
        status: "AUTHORISED",
        invoice_type: "ACCREC",
        invoice_date: "2026-06-30",
      }],
      pack_sent_events: [{
        id: "evt-canonical",
        created_at: "2026-06-30T08:32:01Z",
        text: CANONICAL_PACK_SENT,
      }],
      // Keep sibling data; own path wins when sibling_job_id is not forced.
    }),
    proven_by: "operator",
  });
  assertEquals(plan.path, "own_raised_invoice");
  assertEquals(plan.sibling_invoice_number, "INV-9999");
  assertEquals(plan.proven_at, "2026-06-30T08:32:01.000Z");
});

Deno.test("covering same-kind proof for the current cycle set refuses", async () => {
  const currentHash = await makesafeAttendanceCycleSetHash([CYCLE]);
  const err = await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation({
          existing_proofs: [{
            id: "proof-1",
            kind: "verified_historical_closeout",
            attendance_cycle_set_hash: currentHash,
          }],
        }),
        proven_by: "operator",
      }),
    RecordTerminalProofConflictError,
  ) as RecordTerminalProofConflictError;
  assertEquals(err.code, "terminal_proof_already_recorded");
});

Deno.test("probe A: superseded same-kind proof after reattend does not wall a covering write", async () => {
  // Old proof covered C1 only. Current set is C1+C2 after re-attendance.
  // U2 semantics: hash differs → plan a fresh covering proof.
  const plan = await planMakesafeTerminalProofRecord({
    observation: baseObservation({
      cycle_ids: [CYCLE, CYCLE_2],
      existing_proofs: [{
        id: "proof-old-cycle1-only",
        kind: "verified_historical_closeout",
        attendance_cycle_set_hash: "sha256:deadbeef",
      }],
    }),
    proven_by: "adversarial-probe",
  });
  assertEquals(plan.path, "sibling_bundle");
  const expectedHash = await makesafeAttendanceCycleSetHash([CYCLE, CYCLE_2]);
  assertEquals(plan.attendance_cycle_set_hash, expectedHash);
  assertEquals(plan.attendance_cycle_ids.sort(), [CYCLE, CYCLE_2].sort());
});

Deno.test("probe B: caller proven_at that is not an observed instant refuses", async () => {
  const err = await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation(),
        proven_by: "adversarial-probe",
        proven_at: "2020-01-01T00:00:00.000Z",
      }),
    RecordTerminalProofConflictError,
  ) as RecordTerminalProofConflictError;
  assertEquals(err.code, "proven_at_not_observed");
});

Deno.test("caller proven_at that echoes the observed pack-sent time is accepted", async () => {
  const plan = await planMakesafeTerminalProofRecord({
    observation: baseObservation(),
    proven_by: "operator",
    proven_at: "2026-06-30T08:32:21.612Z",
  });
  assertEquals(plan.proven_at, "2026-06-30T08:32:21.612Z");
});

Deno.test("probe C: own path refuses triage-only freeform note without canonical pack-sent", async () => {
  const err = await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation({
          outbound_bindings: [],
          reverse_bindings: [],
          sibling_raised_invoices: [],
          own_raised_invoices: [{
            id: "own-inv",
            job_id: JOB,
            invoice_number: "INV-9999",
            status: "AUTHORISED",
            invoice_type: "ACCREC",
            invoice_date: "2026-08-01",
          }],
          pack_sent_events: [{
            id: "evt-fake",
            created_at: "2026-08-01T12:00:00Z",
            text:
              "BUNDLED into sibling covered under INV-9999 — will send later",
          }],
          pack_sent_at: null,
        }),
        proven_by: "adversarial-probe",
      }),
    RecordTerminalProofConflictError,
  ) as RecordTerminalProofConflictError;
  assertEquals(err.code, "pack_send_evidence_missing");
});

Deno.test("caller evidence_refs are refused", async () => {
  const err = await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation(),
        proven_by: "operator",
        extra_evidence_refs: ["invented:citation"],
      }),
    RecordTerminalProofRequestError,
  );
  assert(String(err.message).includes("evidence_refs"));
});

Deno.test("proven_by is required", async () => {
  await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation(),
        proven_by: "  ",
      }),
    RecordTerminalProofRequestError,
  );
});

Deno.test("release_closeout kind is refused here (send path owns it)", async () => {
  await assertRejects(
    () =>
      planMakesafeTerminalProofRecord({
        observation: baseObservation(),
        proven_by: "operator",
        kind: "release_closeout",
      }),
    RecordTerminalProofRequestError,
  );
});

Deno.test("a planned bundled proof places SWMS-26832 into archive via the stage engine", async () => {
  const plan = await planMakesafeTerminalProofRecord({
    observation: baseObservation(),
    proven_by: "ses-codefix:swms-26832-bundled-closeout",
  });
  const hash = await makesafeAttendanceCycleSetHash(plan.attendance_cycle_ids);
  // Cast matches ses_stage_engine_v2_terminal_proof_test: detail carries the
  // cycle id the board loader stamps; the published SesStageV2Input type lags.
  const result = deriveSesStageV2({
    job: {
      status: "invoiced",
      metadata: { makesafe_job_family: "general_makesafe" },
    },
    detail: { cycle_number: 1, attendance_cycle_id: CYCLE },
    evidence: {
      assignments: [{ id: "a1", status: "complete" }],
      serviceReports: [],
      completionPhotoCount: 0,
      invoiceStatus: null,
      packSent: true,
      attendanceCycleIds: [CYCLE],
      currentAttendanceCycleId: CYCLE,
      terminalProofs: [{
        id: "proof-planned",
        kind: plan.kind,
        attendance_cycle_ids: plan.attendance_cycle_ids,
        evidence_refs: plan.evidence_refs,
        proven_by: plan.proven_by,
        proven_at: plan.proven_at,
        validatedCycleSetHash: true,
      }],
    },
    nowIso: "2026-08-24T00:00:00.000Z",
  } as any);
  assertEquals(hash, plan.attendance_cycle_set_hash);
  assertEquals(result.stage, "archive");
  assert(
    result.reasons.some((r) => r.includes("verified_historical_closeout")),
  );
});

Deno.test("dry_run default: action observes + plans and inserts nothing", async () => {
  const inserts: any[] = [];
  const client = {
    from(table: string) {
      const filters: Array<{ op: string; col: string; val: any }> = [];
      const api: any = {
        select() {
          return api;
        },
        eq(col: string, val: any) {
          filters.push({ op: "eq", col, val });
          return api;
        },
        in(col: string, val: any) {
          filters.push({ op: "in", col, val });
          return api;
        },
        order() {
          return api;
        },
        limit() {
          return api;
        },
        maybeSingle: async () => {
          if (table === "jobs") {
            return {
              data: {
                id: JOB,
                org_id: ORG,
                job_number: "SWMS-26832",
                type: "makesafe",
                status: "invoiced",
              },
              error: null,
            };
          }
          if (table === "makesafe_report_packs") {
            return { data: null, error: null };
          }
          return { data: null, error: null };
        },
        insert(row: any) {
          inserts.push(row);
          return {
            select() {
              return {
                maybeSingle: async () => ({ data: { id: "new" }, error: null }),
              };
            },
          };
        },
        then: undefined,
      };
      const resultFor = () => {
        if (table === "makesafe_attendance_cycles") {
          return { data: [{ id: CYCLE }], error: null };
        }
        if (table === "makesafe_terminal_proofs") {
          return { data: [], error: null };
        }
        if (table === "xero_invoices") {
          const eqJob = filters.find((f) => f.op === "eq" && f.col === "job_id");
          if (eqJob && eqJob.val === JOB) {
            return { data: [], error: null }; // no own raised invoice
          }
          return {
            data: [{
              id: INV,
              job_id: SIBLING,
              invoice_number: "INV-0835",
              status: "PAID",
              invoice_type: "ACCREC",
              invoice_date: "2026-06-30",
            }],
            error: null,
          };
        }
        if (table === "job_events") {
          return {
            data: [{
              id: "evt-bundled",
              event_type: "note",
              created_at: "2026-06-30T08:32:21.612Z",
              detail_json: { text: SWMS_26832_LEGACY_NOTE },
            }],
            error: null,
          };
        }
        if (table === "makesafe_sibling_bundle_binding_revisions") {
          const eqJob = filters.find((f) => f.op === "eq" && f.col === "job_id");
          if (eqJob && eqJob.val === JOB) {
            return {
              data: [{
                id: BINDING,
                job_id: JOB,
                sibling_job_id: SIBLING,
                bundle_id: BUNDLE,
                org_id: ORG,
                state: "bound",
                recorded_at: "2026-07-28T04:00:00Z",
              }],
              error: null,
            };
          }
          return {
            data: [{
              id: REVERSE,
              job_id: SIBLING,
              sibling_job_id: JOB,
              bundle_id: BUNDLE,
              org_id: ORG,
              state: "bound",
              recorded_at: "2026-07-28T04:00:00Z",
            }],
            error: null,
          };
        }
        return { data: [], error: null };
      };
      api.then = (resolve: any, reject: any) =>
        Promise.resolve(resultFor()).then(resolve, reject);
      return api;
    },
  };

  const result = await recordMakesafeTerminalProofAction(client, {
    job_id: JOB,
    proven_by: "ses-codefix:test",
    // dry_run omitted → default true
  });
  assertEquals(result.dry_run, true);
  assertEquals(result.would_insert, true);
  assertEquals(result.path, "sibling_bundle");
  assertEquals(inserts.length, 0);
});

Deno.test("missing proven_by on the action is a 400", async () => {
  await assertRejects(
    () => recordMakesafeTerminalProofAction({}, { job_id: JOB, dry_run: true }),
    RecordTerminalProofRequestError,
  );
});
