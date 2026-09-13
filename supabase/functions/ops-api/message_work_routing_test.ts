import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyLinkCorrection, routeMessage } from "./message_work_routing.ts";

const org = "00000000-0000-4000-8000-0000000000aa";
const other = "00000000-0000-4000-8000-0000000000bb";
const jobA = "aaaaaaaa-0000-4000-8000-000000000001";
const jobB = "bbbbbbbb-0000-4000-8000-000000000002";
const jobs = [
  { org_id: org, job_id: jobA, job_number: "SWP-261001" },
  { org_id: org, job_id: jobB, job_number: "SWP-261002" },
  { org_id: other, job_id: "cccccccc-0000-4000-8000-000000000003", job_number: "SWP-261001" },
];

Deno.test("changed subject still links on explicit id", () => {
  const r = routeMessage({
    org_id: org,
    subject: "Re: totally different",
    explicit_ids: [{ kind: "job", id: jobA }],
    candidate_jobs: jobs,
  });
  assertEquals(r.links[0].id, jobA);
  assertEquals(r.unresolved, false);
});

Deno.test("forward with two job numbers is unresolved", () => {
  const r = routeMessage({
    org_id: org,
    subject: "Fwd: materials",
    body: "SWP-261001 and SWP-261002 both need steel",
    candidate_jobs: jobs,
  });
  assertEquals(r.unresolved, true);
  assertEquals(r.reason, "multiple_work_refs");
});

Deno.test("supplier with two jobs and no explicit id stays unresolved", () => {
  const r = routeMessage({
    org_id: org,
    subject: "PO update",
    body: "as discussed",
    in_reply_to: "<thread@example.test>",
    candidate_jobs: jobs,
  });
  assertEquals(r.unresolved, true);
  assertEquals(r.reason, "thread_ambiguous");
});

Deno.test("repeated reference still one explicit job", () => {
  const r = routeMessage({
    org_id: org,
    body: "SWP-261001 SWP-261001",
    candidate_jobs: jobs,
  });
  assertEquals(r.links.length, 1);
  assertEquals(r.links[0].id, jobA);
});

Deno.test("no evidence is unresolved, not guessed", () => {
  const r = routeMessage({ org_id: org, subject: "hello", candidate_jobs: jobs });
  assertEquals(r.unresolved, true);
  assertEquals(r.reason, "no_evidence");
});

Deno.test("quoted stale job number does not silent-link", () => {
  const r = routeMessage({
    org_id: org,
    quoted: true,
    body: "On Monday you wrote about SWP-261001",
    candidate_jobs: jobs,
  });
  assertEquals(r.unresolved, true);
  assertEquals(r.reason, "quoted_stale_reference");
});

Deno.test("cross-tenant job number does not link", () => {
  const r = routeMessage({
    org_id: org,
    body: "SWP-261001",
    candidate_jobs: jobs.filter((j) => j.org_id === other),
  });
  assertEquals(r.unresolved, true);
});

Deno.test("manual correction unlinks then links", () => {
  const first = routeMessage({
    org_id: org,
    explicit_ids: [{ kind: "job", id: jobA }],
    candidate_jobs: jobs,
  });
  const unlinked = applyLinkCorrection(first, { op: "unlink", kind: "job", id: jobA });
  assertEquals(unlinked.unresolved, true);
  const linked = applyLinkCorrection(unlinked, { op: "link", kind: "job", id: jobB });
  assertEquals(linked.links[0].id, jobB);
  assertEquals(linked.reason, "manual_link");
});
