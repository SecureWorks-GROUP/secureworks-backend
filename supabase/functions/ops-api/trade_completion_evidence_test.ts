// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  completionEvidenceMessage,
  evaluateCompletionEvidence,
  loadCompletionEvidenceByJob,
  namedNeighbourCount,
  requiredNeighbourSignoffs,
} from "./trade_completion_evidence.ts";

Deno.test("named neighbours: blank seeded row does not count, any filled field does", () => {
  assertEquals(namedNeighbourCount({ job: { neighbours: [{ id: "nb-1", firstName: "", lastName: "", address: "" }] } }), 0);
  assertEquals(namedNeighbourCount({ job: { neighbours: [{ firstName: "Sue" }, { address: "22 Trappers Dr" }, {}] } }), 2);
  assertEquals(requiredNeighbourSignoffs(null), 1);
  assertEquals(requiredNeighbourSignoffs({ job: { neighbours: [{ firstName: "A" }, { firstName: "B" }] } }), 2);
});

Deno.test("evaluate: fencing needs 3 completion photos and one sign-off per named neighbour", () => {
  const job = { id: "j1", vertical: "fencing", scope_json: { job: { neighbours: [{ firstName: "A" }, { firstName: "B" }] } } };
  const media = [
    ...[1, 2, 3].map((i) => ({ job_id: "j1", phase: "completion", type: "photo", id: `c${i}` })),
    { job_id: "j1", phase: "neighbour_signoff", type: "photo" },
    { job_id: "j1", phase: "scope", type: "photo" },
    { job_id: "j1", phase: "completion", type: "video" },
  ];
  const ev = evaluateCompletionEvidence({ job, media, events: [] });
  assertEquals(ev.photos, 3);
  assertEquals(ev.signoffs, 1);
  assertEquals(ev.signoffs_required, 2);
  assertEquals(ev.satisfied, false);
  assertEquals(ev.missing, ["neighbour_signoff"]);
  assertEquals(
    completionEvidenceMessage(ev, "SWF-1"),
    "SWF-1 cannot be invoiced yet. Complete the job in the app first: 1 of 2 neighbour sign-off screenshots on file.",
  );
  const waived = evaluateCompletionEvidence({ job, media, events: [{ event_type: "neighbour_signoff_waived", detail_json: { reason: "Both neighbours are the same owner" } }] });
  assertEquals(waived.satisfied, true);
  assertEquals(waived.waiver_reason, "Both neighbours are the same owner");
});

Deno.test("evaluate: non-fencing never applies; a failed read fails closed", () => {
  const patio = evaluateCompletionEvidence({ job: { id: "p", vertical: "patio" }, media: [], events: [] });
  assertEquals(patio.applies, false);
  assertEquals(patio.satisfied, true);
  const failed = evaluateCompletionEvidence({ job: { id: "f", vertical: "fencing" }, media: [], events: [], readFailed: true });
  assertEquals(failed.satisfied, false);
  assertEquals(failed.missing[0], "evidence_unavailable");
  assertEquals(completionEvidenceMessage(failed).includes("could not be checked"), true);
});

Deno.test("load: batches by job, reads scope only when not supplied, fails closed on a read error", async () => {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      const q: any = {
        select: () => q,
        in: () => q,
        eq: () => q,
        then: (res: any) => {
          calls.push(table);
          if (table === "jobs") return Promise.resolve({ data: [{ id: "j2", scope_json: { job: { neighbours: [{ firstName: "N" }, { firstName: "M" }] } } }], error: null }).then(res);
          if (table === "job_media") return Promise.resolve({ data: [
            { job_id: "j1", phase: "completion", type: "photo" }, { job_id: "j1", phase: "completion", type: "photo" }, { job_id: "j1", phase: "completion", type: "photo" }, { job_id: "j1", phase: "neighbour_signoff" },
            { job_id: "j2", phase: "completion", type: "photo" },
          ], error: null }).then(res);
          return Promise.resolve({ data: [], error: null }).then(res);
        },
      };
      return q;
    },
  };
  const map = await loadCompletionEvidenceByJob(client, [
    { id: "j1", vertical: "fencing", scope_json: {} },
    { id: "j2", vertical: "fencing" },
    { id: "p1", vertical: "patio" },
  ]);
  assertEquals(map.get("j1")?.satisfied, true);
  assertEquals(map.get("j2")?.signoffs_required, 2);
  assertEquals(map.get("j2")?.photos, 1);
  assertEquals(map.get("p1")?.applies, false);
  assertEquals(calls.sort(), ["job_events", "job_media", "jobs"]);

  const broken = { from: () => ({ select() { return this; }, in() { return this; }, eq() { return this; }, then: (res: any) => Promise.resolve({ data: null, error: { message: "boom" } }).then(res) }) };
  const failed = await loadCompletionEvidenceByJob(broken, [{ id: "j1", vertical: "fencing", scope_json: {} }]);
  assertEquals(failed.get("j1")?.satisfied, false);
  assertEquals(failed.get("j1")?.read_failed, true);
});
