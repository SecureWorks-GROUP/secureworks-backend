// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clientSignoffApplies,
  clientSignoffMessage,
  clientSignoffRequired,
  currentClientSignoff,
  DEFAULT_CLIENT_SIGNOFF_SETTINGS,
  evaluateClientSignoff,
  loadClientSignoffByJob,
  signoffRowCounts,
} from "./trade_client_signoff.ts";

const S = DEFAULT_CLIENT_SIGNOFF_SETTINGS;

// A table-keyed fake: every read of a table answers its configured result,
// and each query is recorded so a test can prove a table was never read.
function fakeClient(tables: Record<string, { data?: any; error?: any; throws?: boolean }>) {
  const reads: string[] = [];
  return {
    reads,
    from(table: string) {
      reads.push(table);
      const result = tables[table] ?? { data: [], error: null };
      const q: any = {
        select: () => q,
        eq: () => q,
        in: () => q,
        limit: () => q,
        order: () => q,
        then(resolve: any, reject: any) {
          if (result.throws) return Promise.reject(new Error("boom")).then(resolve, reject);
          return Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject);
        },
      };
      return q;
    },
  };
}

const flagOn = { feature_flags: { data: [{ enabled: true }] } };

Deno.test("applies: only the gated job types, and only jobs completed on or after applies_from", () => {
  assertEquals(clientSignoffApplies({ id: "j", type: "fencing" }, S), true);
  assertEquals(clientSignoffApplies({ id: "j", type: "Patio" }, S), true);
  assertEquals(clientSignoffApplies({ id: "j", type: "makesafe" }, S), false);
  assertEquals(clientSignoffApplies({ id: "j", type: "repair" }, S), false);
  const from = { ...S, applies_from: "2026-11-01T00:00:00Z" };
  assertEquals(clientSignoffApplies({ id: "j", type: "fencing", completed_at: "2026-10-20T00:00:00Z" }, from), false);
  assertEquals(clientSignoffApplies({ id: "j", type: "fencing", completed_at: "2026-11-01T00:00:00Z" }, from), true);
  assertEquals(clientSignoffApplies({ id: "j", type: "fencing", completed_at: null }, from), true);
});

Deno.test("current: newest row wins, ties break on id", () => {
  const rows = [
    { id: "a", job_id: "j", method: "on_site", happy: false, created_at: "2026-10-19T01:00:00Z" },
    { id: "b", job_id: "j", method: "office_waiver", created_at: "2026-10-19T02:00:00Z" },
  ];
  assertEquals(currentClientSignoff(rows)?.id, "b");
  const tie = [
    { id: "a", job_id: "j", method: "on_site", created_at: "2026-10-19T02:00:00Z" },
    { id: "c", job_id: "j", method: "on_site", created_at: "2026-10-19T02:00:00Z" },
  ];
  assertEquals(currentClientSignoff(tie)?.id, "c");
  assertEquals(currentClientSignoff([]), null);
});

Deno.test("evaluate: no row is not_signed; a gated job is held, an ungated one is not", () => {
  const held = evaluateClientSignoff({ job: { id: "j", type: "fencing" }, rows: [], settings: S });
  assertEquals([held.applies, held.satisfied, held.missing], [true, false, "not_signed"]);
  const free = evaluateClientSignoff({ job: { id: "j", type: "makesafe" }, rows: [], settings: S });
  assertEquals([free.applies, free.satisfied], [false, true]);
});

Deno.test("evaluate: on-site counts unless not happy or rated under the threshold", () => {
  const base = { id: "r", job_id: "j", method: "on_site", signed_name: "A", created_at: "2026-10-19T00:00:00Z" };
  const job = { id: "j", type: "fencing" };
  const ok = evaluateClientSignoff({ job, rows: [{ ...base, happy: true, satisfaction_rating: 5 }], settings: S });
  assertEquals([ok.satisfied, ok.missing], [true, null]);
  const unhappy = evaluateClientSignoff({ job, rows: [{ ...base, happy: false, satisfaction_rating: 5 }], settings: S });
  assertEquals(unhappy.missing, "client_not_happy");
  const low = evaluateClientSignoff({ job, rows: [{ ...base, happy: true, satisfaction_rating: 3 }], settings: S });
  assertEquals(low.missing, "rating_below_threshold");
  // PROPOSAL: the current app sends no happy tick; a passing rating counts.
  const legacy = evaluateClientSignoff({ job, rows: [{ ...base, happy: null, satisfaction_rating: 4 }], settings: S });
  assertEquals(legacy.satisfied, true);
  const noRating = evaluateClientSignoff({ job, rows: [{ ...base, happy: null, satisfaction_rating: null }], settings: S });
  assertEquals(noRating.satisfied, true);
});

Deno.test("invoicing: a newest revoked sign-off blocks, and an unrevoked signature allows", async () => {
  const drawn = {
    id: "drawn",
    job_id: "j",
    method: "on_site",
    happy: true,
    satisfaction_rating: 5,
    signature_media_id: "sig-1",
    created_at: "2026-10-19T01:00:00Z",
  };
  // The revoked row itself looks happy and well rated, so a check that only
  // reads happy or rating would still let invoicing through.
  const revoked = {
    id: "revoked-row",
    job_id: "j",
    method: "revoked",
    happy: true,
    satisfaction_rating: 5,
    created_at: "2026-10-19T02:00:00Z",
  };
  const held = evaluateClientSignoff({
    job: { id: "j", type: "fencing" },
    rows: [drawn, revoked],
    settings: S,
  });
  assertEquals([held.satisfied, held.missing, held.current?.method], [false, "not_signed", "revoked"]);
  assertEquals(
    clientSignoffMessage(held, "SWF-1"),
    "SWF-1 cannot be invoiced yet: waiting for the client to sign the job off.",
  );

  const blocked = fakeClient({ ...flagOn, job_client_signoffs: { data: [drawn, revoked] } });
  const blockedMap = await loadClientSignoffByJob(blocked, [{ id: "j", type: "fencing" }]);
  assertEquals([blockedMap?.get("j")?.satisfied, blockedMap?.get("j")?.missing], [false, "not_signed"]);

  const open = fakeClient({ ...flagOn, job_client_signoffs: { data: [drawn] } });
  const openMap = await loadClientSignoffByJob(open, [{ id: "j", type: "fencing" }]);
  assertEquals([openMap?.get("j")?.satisfied, openMap?.get("j")?.missing], [true, null]);
});

Deno.test("evaluate: a waiver always counts, and a newer unhappy sign-off replaces an older happy one", () => {
  const job = { id: "j", type: "patio" };
  const waiver = evaluateClientSignoff({
    job,
    rows: [{ id: "w", job_id: "j", method: "office_waiver", waiver_reason: "client not responding", created_at: "2026-10-19T00:00:00Z" }],
    settings: S,
  });
  assertEquals(waiver.satisfied, true);
  const replaced = evaluateClientSignoff({
    job,
    rows: [
      { id: "a", job_id: "j", method: "on_site", happy: true, satisfaction_rating: 5, created_at: "2026-10-18T00:00:00Z" },
      { id: "b", job_id: "j", method: "on_site", happy: false, satisfaction_rating: 2, created_at: "2026-10-19T00:00:00Z" },
    ],
    settings: S,
  });
  assertEquals([replaced.satisfied, replaced.current?.id], [false, "b"]);
});

Deno.test("evaluate: a failed read is evidence_unavailable and never satisfied on a gated job", () => {
  const ev = evaluateClientSignoff({ job: { id: "j", type: "fencing" }, rows: [], settings: S, readFailed: true });
  assertEquals([ev.satisfied, ev.missing, ev.read_failed], [false, "evidence_unavailable", true]);
});

Deno.test("signoffRowCounts ignores job type and applies_from", () => {
  const settings = { ...S, applies_from: "2099-01-01T00:00:00Z" };
  assertEquals(signoffRowCounts({ id: "r", job_id: "j", method: "on_site", happy: true, satisfaction_rating: 5, created_at: "x" }, settings), true);
  assertEquals(signoffRowCounts({ id: "r", job_id: "j", method: "on_site", happy: false, created_at: "x" }, settings), false);
});

Deno.test("message: names the job and says what it waits on, with no client detail", () => {
  const ev = evaluateClientSignoff({ job: { id: "j", type: "fencing" }, rows: [], settings: S });
  assertEquals(clientSignoffMessage(ev, "SWF-1"), "SWF-1 cannot be invoiced yet: waiting for the client to sign the job off.");
  const unread = evaluateClientSignoff({ job: { id: "j", type: "fencing" }, rows: [], settings: S, readFailed: true });
  assertEquals(clientSignoffMessage(unread).startsWith("This job cannot be invoiced yet: the client sign-off could not be checked"), true);
});

Deno.test("flag: missing, false, unreadable or throwing is off", async () => {
  assertEquals(await clientSignoffRequired(fakeClient({ feature_flags: { data: [] } })), false);
  assertEquals(await clientSignoffRequired(fakeClient({ feature_flags: { data: [{ enabled: false }] } })), false);
  assertEquals(await clientSignoffRequired(fakeClient({ feature_flags: { error: { message: "x" } } })), false);
  assertEquals(await clientSignoffRequired(fakeClient({ feature_flags: { throws: true } })), false);
  assertEquals(await clientSignoffRequired(fakeClient(flagOn)), true);
});

Deno.test("loader: flag off returns null and reads no sign-off", async () => {
  const c = fakeClient({ feature_flags: { data: [{ enabled: false }] } });
  assertEquals(await loadClientSignoffByJob(c, [{ id: "j", type: "fencing" }]), null);
  assertEquals(c.reads.includes("job_client_signoffs"), false);
});

Deno.test("loader: ungated jobs pass without a sign-off query; gated jobs read their rows", async () => {
  const onlyUngated = fakeClient({ ...flagOn, client_signoff_settings: { data: [] } });
  const a = await loadClientSignoffByJob(onlyUngated, [{ id: "m", type: "makesafe" }]);
  assertEquals(a?.get("m")?.satisfied, true);
  assertEquals(onlyUngated.reads.includes("job_client_signoffs"), false);

  const c = fakeClient({
    ...flagOn,
    client_signoff_settings: { data: [{ min_happy_rating: 4, gated_job_types: ["fencing", "patio"], applies_from: null }] },
    job_client_signoffs: {
      data: [{ id: "r", job_id: "f1", method: "on_site", happy: true, satisfaction_rating: 5, created_at: "2026-10-19T00:00:00Z" }],
    },
  });
  const m = await loadClientSignoffByJob(c, [{ id: "f1", type: "fencing" }, { id: "f2", type: "fencing" }, { id: "m", type: "makesafe" }]);
  assertEquals(m?.get("f1")?.satisfied, true);
  assertEquals(m?.get("f2")?.missing, "not_signed");
  assertEquals(m?.get("m")?.applies, false);
});

Deno.test("loader: with the flag on, a failed sign-off or settings read holds every gated job", async () => {
  const badRows = fakeClient({ ...flagOn, job_client_signoffs: { error: { message: "x" } } });
  const a = await loadClientSignoffByJob(badRows, [{ id: "f", type: "fencing" }]);
  assertEquals([a?.get("f")?.satisfied, a?.get("f")?.missing], [false, "evidence_unavailable"]);

  // Unreadable settings cannot say a job is outside the gate.
  const badSettings = fakeClient({ ...flagOn, client_signoff_settings: { error: { message: "x" } } });
  const b = await loadClientSignoffByJob(badSettings, [{ id: "m", type: "makesafe" }]);
  assertEquals([b?.get("m")?.applies, b?.get("m")?.satisfied], [true, false]);
});

Deno.test("chunks: ids split at 100 per filter, nothing lost", async () => {
  const { chunkClientSignoffIds } = await import("./trade_client_signoff.ts");
  const ids = Array.from({ length: 205 }, (_, i) => `j${i}`);
  const chunks = chunkClientSignoffIds(ids);
  assertEquals(chunks.map((c) => c.length), [100, 100, 5]);
  assertEquals(chunks.flat(), ids);
});
