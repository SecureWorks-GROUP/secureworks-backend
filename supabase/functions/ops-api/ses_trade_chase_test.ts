// deno-lint-ignore-file no-import-prefix no-explicit-any require-await
//
// Harden SES ticket 10: automated trade chase on the 4 PM next-day KPI.
//
// Pins:
//   1. Disabled flag returns an inert summary — no reads, no sends.
//   2. An overdue allocated card texts its assigned trade exactly once per
//      local day; the second pass says already_chased_today.
//   3. Within-KPI cards are left alone (not_overdue), including the
//      weekend-aware due date (Friday work is due Monday 4 PM).
//   4. The Captain's number is never texted (phone_forbidden), missing
//      phones and assignments are skipped honestly.
//   5. A send failure parks the effect at `failed` and never throws.
//   6. Migration adds the trade_chase_sms arm with the money-null shape and
//      per-day unique index; the rollback twin restores the prior set.

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  runSesTradeChase,
  SES_TRADE_CHASE_VERSION,
  sesTradeChaseDueLocal,
  type SesTradeChaseAssignment,
  type SesTradeChaseCard,
  type SesTradeChaseDeps,
} from "./ses_trade_chase.ts";
import type { SesExternalEffectStore } from "./ses_external_effects.ts";

const CAPTAIN = "+61404777984";

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

function card(jobId: string): SesTradeChaseCard {
  return {
    job_id: jobId,
    job_number: `SWMS-${jobId}`,
    address: "12 Sample St, Duncraig",
  };
}

function makeDeps(overrides: Partial<SesTradeChaseDeps>): SesTradeChaseDeps {
  const { store } = makeFakeStore(new Set());
  return {
    org_id: "org-1",
    enabled: true,
    // 2026-08-06 (Thursday) work; "now" is Friday 2026-08-07 17:00 Perth
    // = 09:00Z — one hour past the Friday 4 PM KPI.
    now: new Date("2026-08-07T09:00:00Z"),
    store,
    sendSms: async () => true,
    listCards: async () => [card("j1")],
    latestLiveAssignment: async () => ({
      user_name: "Hugo",
      phone: "+61400000001",
      scheduled_date: "2026-08-06",
    }),
    forbiddenPhones: [CAPTAIN],
    actor: "test",
    ...overrides,
  };
}

Deno.test("disabled flag is inert — no cards read, no sends", async () => {
  let listed = 0;
  const summary = await runSesTradeChase(makeDeps({
    enabled: false,
    listCards: async () => {
      listed++;
      return [card("j1")];
    },
  }));
  assertEquals(summary.enabled, false);
  assertEquals(summary.chases, []);
  assertEquals(listed, 0);
});

Deno.test("overdue card texts the trade once; second pass is a no-op", async () => {
  const seen = new Set<string>();
  const { store, transitions } = makeFakeStore(seen);
  const sent: string[] = [];
  const deps = makeDeps({
    store,
    sendSms: async (phone, message) => {
      sent.push(`${phone}|${message}`);
      return true;
    },
  });
  const first = await runSesTradeChase(deps);
  assertEquals(first.chases[0].outcome, "sent");
  assertEquals(sent.length, 1);
  assertStringIncludes(sent[0], "+61400000001|");
  assertStringIncludes(sent[0], "SWMS-j1");
  assertStringIncludes(sent[0], "Trade app");
  assertEquals(transitions, ["reserved->dispatching", "dispatching->confirmed"]);

  const second = await runSesTradeChase(deps);
  assertEquals(second.chases[0].outcome, "already_chased_today");
  assertEquals(sent.length, 1);
});

Deno.test("KPI due dates skip weekends", () => {
  // Thursday work -> Friday 4 PM.
  assertEquals(
    sesTradeChaseDueLocal("2026-08-06")!.toISOString(),
    "2026-08-07T16:00:00.000Z",
  );
  // Friday work -> Monday 4 PM.
  assertEquals(
    sesTradeChaseDueLocal("2026-08-07")!.toISOString(),
    "2026-08-10T16:00:00.000Z",
  );
  // Garbage date -> null.
  assertEquals(sesTradeChaseDueLocal("not-a-date"), null);
});

Deno.test("within-KPI card is left alone", async () => {
  const sent: string[] = [];
  const summary = await runSesTradeChase(makeDeps({
    // Same-day 15:00 Perth (07:00Z): report due tomorrow, nothing owed yet.
    now: new Date("2026-08-06T07:00:00Z"),
    sendSms: async (phone, message) => {
      sent.push(`${phone}|${message}`);
      return true;
    },
  }));
  assertEquals(summary.chases[0].outcome, "not_overdue");
  assertEquals(sent, []);
});

Deno.test("Captain's phone is never texted; missing data skips honestly", async () => {
  const sent: string[] = [];
  const sendSms = async (phone: string, _m: string) => {
    sent.push(phone);
    return true;
  };
  const captainised = await runSesTradeChase(makeDeps({
    sendSms,
    latestLiveAssignment: async () => ({
      user_name: "Marnin",
      phone: "+61 404 777 984",
      scheduled_date: "2026-08-06",
    }),
  }));
  assertEquals(captainised.chases[0].outcome, "phone_forbidden");

  const noPhone = await runSesTradeChase(makeDeps({
    sendSms,
    latestLiveAssignment: async () => ({
      user_name: "Hugo",
      phone: null,
      scheduled_date: "2026-08-06",
    }),
  }));
  assertEquals(noPhone.chases[0].outcome, "no_phone");

  const noAssignment = await runSesTradeChase(makeDeps({
    sendSms,
    latestLiveAssignment: async () => null,
  }));
  assertEquals(noAssignment.chases[0].outcome, "no_assignment");
  assertEquals(sent, []);
});

Deno.test("send failure parks the effect at failed and never throws", async () => {
  const seen = new Set<string>();
  const { store, transitions } = makeFakeStore(seen);
  const summary = await runSesTradeChase(makeDeps({
    store,
    sendSms: async () => false,
  }));
  assertEquals(summary.chases[0].outcome, "failed");
  assertEquals(transitions, ["reserved->dispatching", "dispatching->failed"]);
});

Deno.test("one bad card does not stop the pass", async () => {
  const summary = await runSesTradeChase(makeDeps({
    listCards: async () => [card("j-bad"), card("j-good")],
    latestLiveAssignment: async (jobId) => {
      if (jobId === "j-bad") throw new Error("assignment read exploded");
      return {
        user_name: "Hugo",
        phone: "+61400000001",
        scheduled_date: "2026-08-06",
      } as SesTradeChaseAssignment;
    },
  }));
  assertEquals(summary.checked, 2);
  assertEquals(summary.chases[0].outcome, "failed");
  assertEquals(summary.chases[1].outcome, "sent");
});

Deno.test("migration adds trade_chase_sms arm + per-day index; rollback restores", async () => {
  const up = await Deno.readTextFile(
    new URL(
      "../../migrations/20260807170000_ses_trade_chase_effect.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(up, "'trade_chase_sms'");
  assertStringIncludes(up, "uq_ses_external_trade_chase_sms");
  assertStringIncludes(
    up,
    "effect_kind = 'trade_chase_sms'\n      AND job_id IS NOT NULL\n      AND artifact_hash IS NOT NULL",
  );
  assertStringIncludes(up, "invoice_obligation_revision_id IS NULL");
  const down = await Deno.readTextFile(
    new URL(
      "../../rollbacks/20260807170000_ses_trade_chase_effect_down.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(down, "DROP INDEX IF EXISTS public.uq_ses_external_trade_chase_sms");
  assert(!down.includes("'trade_chase_sms',"));
  assertEquals(SES_TRADE_CHASE_VERSION, "ses.trade-chase/v1");
});
