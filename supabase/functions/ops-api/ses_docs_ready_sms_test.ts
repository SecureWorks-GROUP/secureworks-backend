// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
//
// Harden SES ticket 06: the Captain's ONE Docs Ready SMS.
//
// Pins:
//   1. A ready+persisted result sends exactly one SMS and confirms the effect.
//   2. A duplicate claim (same job, same attendance cycle) sends nothing.
//   3. Blocked or unpersisted results never text.
//   4. A send failure parks the effect at `failed`, logs, and never throws —
//      and never reaches the Captain's phone twice.
//   5. The migration adds the docs_ready_sms arm with the money-null shape and
//      the per-cycle unique index, and the rollback twin restores the prior
//      constraint set.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  notifySesDocsReadySms,
  SES_DOCS_READY_SMS_DEFAULT_TO,
  type SesDocsReadySmsDeps,
} from "./ses_docs_ready_sms.ts";
import type { SesExternalEffectStore } from "./ses_external_effects.ts";

function readyResult(jobId: string, cycleId: string, overrides: any = {}): any {
  return {
    state: "ready",
    persisted: true,
    docket_revision_id: `docket-${jobId}`,
    envelope: {
      spine: { job_id: jobId, current_attendance_cycle_id: cycleId },
    },
    review_spec: {
      address: "12 Sample St, Duncraig",
      cards: [{ job_id: jobId, builder_reference: "MLB-99999" }],
    },
    ...overrides,
  };
}

function makeFakeStore(seenKeys: Set<string>): {
  store: SesExternalEffectStore;
  transitions: string[];
} {
  const transitions: string[] = [];
  const store: SesExternalEffectStore = {
    async claim(effect) {
      if (seenKeys.has(effect.operation_key)) {
        return {
          effect: { ...effect, state: "confirmed" },
          claim_mode: "confirmed",
          duplicate_refused: true,
        };
      }
      seenKeys.add(effect.operation_key);
      return {
        effect: { ...effect, state: "reserved" },
        claim_mode: "dispatch",
        duplicate_refused: false,
      };
    },
    async transition(operationKey, from, to) {
      transitions.push(`${from}->${to}`);
      return { operation_key: operationKey, state: to } as any;
    },
  };
  return { store, transitions };
}

function makeDeps(
  store: SesExternalEffectStore,
  sent: string[],
  sendResult: () => Promise<boolean> = async () => true,
): SesDocsReadySmsDeps {
  return {
    org_id: "org-1",
    store,
    sendSms: async (_phone, message) => {
      const ok = await sendResult();
      if (ok) sent.push(message);
      return ok;
    },
    phone: SES_DOCS_READY_SMS_DEFAULT_TO,
    lookupJobNumber: async () => "SWMS-261000",
    actor: "test-actor",
  };
}

Deno.test("ready persisted result sends one SMS and confirms the effect", async () => {
  const { store, transitions } = makeFakeStore(new Set());
  const sent: string[] = [];
  const outcomes = await notifySesDocsReadySms(
    [readyResult("job-1", "cycle-1")],
    makeDeps(store, sent),
  );
  assertEquals(outcomes, [{ job_id: "job-1", outcome: "sent" }]);
  assertEquals(sent.length, 1);
  assertStringIncludes(sent[0], "Docs Ready: SWMS-261000");
  assertStringIncludes(sent[0], "12 Sample St, Duncraig");
  assertStringIncludes(sent[0], "MLB-99999");
  assertEquals(transitions, ["reserved->dispatching", "dispatching->confirmed"]);
});

Deno.test("same job and cycle never texts twice", async () => {
  const seen = new Set<string>();
  const { store } = makeFakeStore(seen);
  const sent: string[] = [];
  const deps = makeDeps(store, sent);
  await notifySesDocsReadySms([readyResult("job-1", "cycle-1")], deps);
  const second = await notifySesDocsReadySms(
    [readyResult("job-1", "cycle-1")],
    deps,
  );
  assertEquals(second, [{ job_id: "job-1", outcome: "already_notified" }]);
  assertEquals(sent.length, 1);
});

Deno.test("a new attendance cycle may text again", async () => {
  const { store } = makeFakeStore(new Set());
  const sent: string[] = [];
  const deps = makeDeps(store, sent);
  await notifySesDocsReadySms([readyResult("job-1", "cycle-1")], deps);
  await notifySesDocsReadySms([readyResult("job-1", "cycle-2")], deps);
  assertEquals(sent.length, 2);
});

Deno.test("blocked and unpersisted results never text", async () => {
  const { store } = makeFakeStore(new Set());
  const sent: string[] = [];
  const outcomes = await notifySesDocsReadySms(
    [
      readyResult("job-1", "cycle-1", { state: "blocked" }),
      readyResult("job-2", "cycle-2", { persisted: false }),
    ],
    makeDeps(store, sent),
  );
  assertEquals(sent.length, 0);
  assertEquals(outcomes.map((o) => o.outcome), ["not_ready", "not_ready"]);
});

Deno.test("send failure parks the effect at failed and never throws", async () => {
  const { store, transitions } = makeFakeStore(new Set());
  const sent: string[] = [];
  const outcomes = await notifySesDocsReadySms(
    [readyResult("job-1", "cycle-1")],
    makeDeps(store, sent, async () => false),
  );
  assertEquals(outcomes[0].outcome, "failed");
  assertEquals(sent.length, 0);
  assertEquals(transitions, ["reserved->dispatching", "dispatching->failed"]);
});

Deno.test("migration adds the docs_ready_sms arm and index; rollback restores", async () => {
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20260807120000_ses_docs_ready_sms_effect.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(migration, "'docs_ready_sms'");
  assertStringIncludes(migration, "uq_ses_external_docs_ready_sms");
  assertStringIncludes(
    migration.replace(/\s+/g, " "),
    "(effect_kind = 'docs_ready_sms' AND job_id IS NOT NULL AND artifact_hash IS NOT NULL AND release_revision_id IS NULL AND invoice_obligation_revision_id IS NULL AND docket_revision_id IS NULL AND route_kind IS NULL)",
  );
  const rollback = await Deno.readTextFile(
    new URL(
      "../../rollbacks/20260807120000_ses_docs_ready_sms_effect_down.sql",
      import.meta.url,
    ),
  );
  assert(!rollback.includes("'docs_ready_sms',"));
  assertStringIncludes(rollback, "DROP INDEX IF EXISTS public.uq_ses_external_docs_ready_sms");
});
