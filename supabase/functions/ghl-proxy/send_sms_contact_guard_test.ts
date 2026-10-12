// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkSendSmsContactJob } from "./send_sms_contact_guard.ts";
import { guardClient } from "../_shared/job_contact_membership_test_fakes.ts";

const JOB = "10000000-0000-4000-8000-000000000001";
const OTHER_JOB = "10000000-0000-4000-8000-000000000002";
const job = {
  id: JOB,
  ghl_contact_id: "ghlPrimary001",
  client_name: "Pat Primary",
};
const neighbour = {
  id: "jc-1",
  job_id: JOB,
  ghl_contact_id: "ghlNeighbour01",
  status: "active",
  removed_at: null,
};

Deno.test("send_sms guard: the job's main contact is allowed", async () => {
  const sb = guardClient({ job, contacts: [neighbour] });
  const r = await checkSendSmsContactJob(sb, JOB, "ghlPrimary001");
  assertEquals(r.refusal, null);
  assertEquals(r.via, "job_contact");
  assertEquals(r.namedJob, job);
  // The main contact never needs the contact list.
  assertEquals(sb.reads, ["jobs"]);
});

Deno.test("send_sms guard: a neighbour on the same job's contact list is allowed", async () => {
  const r = await checkSendSmsContactJob(
    guardClient({ job, contacts: [neighbour] }),
    JOB,
    "ghlNeighbour01",
  );
  assertEquals(r.refusal, null);
  assertEquals(r.via, "job_party");
  // Evidence custody still sees the job row (it verifies only the job's own contact).
  assertEquals(r.namedJob, job);
});

Deno.test("send_sms guard: a neighbour on a different job is refused (409 body as before)", async () => {
  const r = await checkSendSmsContactJob(
    guardClient({ job, contacts: [{ ...neighbour, job_id: OTHER_JOB }] }),
    JOB,
    "ghlNeighbour01",
  );
  assertEquals(r.refusal, {
    error:
      "Contact mismatch: contactId does not match the job contact. SMS blocked.",
    expected_contact: "ghlPrimary001",
    expected_name: "Pat Primary",
    supplied_contact: "ghlNeighbour01",
  });
});

Deno.test("send_sms guard: a random contact is refused", async () => {
  const r = await checkSendSmsContactJob(
    guardClient({ job, contacts: [neighbour] }),
    JOB,
    "ghlRandom0001",
  );
  assertEquals(r.refusal?.supplied_contact, "ghlRandom0001");
  assertEquals(r.via, null);
});

Deno.test("send_sms guard: a removed or inactive neighbour row is refused", async () => {
  for (
    const row of [
      { ...neighbour, status: "removed", removed_at: "2026-10-01T00:00:00Z" },
      { ...neighbour, status: "inactive" },
      { ...neighbour, removed_at: "2026-10-01T00:00:00Z" },
    ]
  ) {
    const r = await checkSendSmsContactJob(
      guardClient({ job, contacts: [row] }),
      JOB,
      "ghlNeighbour01",
    );
    assertEquals(r.refusal !== null, true, JSON.stringify(row));
  }
});

Deno.test("send_sms guard: a failed contact-list read refuses (fail closed)", async () => {
  for (const opts of [{ contactsError: "timeout" }, { contactsThrows: true }]) {
    const r = await checkSendSmsContactJob(
      guardClient({ job, contacts: [neighbour], ...opts }),
      JOB,
      "ghlNeighbour01",
    );
    assertEquals(r.refusal !== null, true);
    assertEquals(
      String(r.refusal?.error).includes("could not be read"),
      true,
    );
  }
});

Deno.test("send_sms guard: unchanged best-effort paths still send", async () => {
  // No jobId: nothing to match.
  assertEquals(
    (await checkSendSmsContactJob(guardClient({ job }), null, "ghlRandom0001"))
      .refusal,
    null,
  );
  // A job with no contact of its own, a missing job, and a failed job read: as before.
  for (
    const opts of [
      { job: { ...job, ghl_contact_id: null } },
      { job: null },
      { job, jobError: "boom", jobThrows: true },
    ]
  ) {
    const r = await checkSendSmsContactJob(
      guardClient(opts),
      JOB,
      "ghlRandom0001",
    );
    assertEquals(r.refusal, null, JSON.stringify(opts));
  }
});
