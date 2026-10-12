// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  findLiveJobContactForGhlContact,
  isLiveJobContactFor,
} from "./job_contact_membership.ts";
import { guardClient } from "./job_contact_membership_test_fakes.ts";

const jobContactsClient = (
  contacts: Record<string, unknown>[],
  opts: { error?: string; throws?: boolean } = {},
) =>
  guardClient({
    contacts,
    contactsError: opts.error,
    contactsThrows: opts.throws,
  });

const JOB = "10000000-0000-4000-8000-000000000001";
const OTHER_JOB = "10000000-0000-4000-8000-000000000002";

const neighbour = {
  id: "jc-1",
  job_id: JOB,
  ghl_contact_id: "ghlNeighbour01",
  status: "active",
  removed_at: null,
};

Deno.test("a neighbour on the same job's contact list is accepted", async () => {
  const r = await findLiveJobContactForGhlContact(
    jobContactsClient([neighbour]),
    JOB,
    "ghlNeighbour01",
  );
  assertEquals(r, { ok: true, job_contact_id: "jc-1" });
});

Deno.test("an old row with no status counts as active", async () => {
  const r = await findLiveJobContactForGhlContact(
    jobContactsClient([{ ...neighbour, status: null }]),
    JOB,
    "ghlNeighbour01",
  );
  assertEquals(r.ok, true);
});

Deno.test("a neighbour on a different job is refused", async () => {
  const r = await findLiveJobContactForGhlContact(
    jobContactsClient([{ ...neighbour, job_id: OTHER_JOB }]),
    JOB,
    "ghlNeighbour01",
  );
  assertEquals(r, { ok: false, reason: "not_on_job" });
});

Deno.test("a random contact is refused", async () => {
  const r = await findLiveJobContactForGhlContact(
    jobContactsClient([neighbour]),
    JOB,
    "ghlRandom0001",
  );
  assertEquals(r, { ok: false, reason: "not_on_job" });
});

Deno.test("a removed or soft-deleted neighbour row is refused", async () => {
  for (
    const row of [
      { ...neighbour, status: "removed", removed_at: "2026-10-01T00:00:00Z" },
      { ...neighbour, status: "removed" },
      { ...neighbour, status: "inactive" },
      { ...neighbour, removed_at: "2026-10-01T00:00:00Z" },
    ]
  ) {
    const r = await findLiveJobContactForGhlContact(
      jobContactsClient([row]),
      JOB,
      "ghlNeighbour01",
    );
    assertEquals(r, { ok: false, reason: "not_on_job" }, JSON.stringify(row));
  }
});

Deno.test("a failed or throwing read is lookup_failed (callers fail closed)", async () => {
  const errored = await findLiveJobContactForGhlContact(
    jobContactsClient([neighbour], { error: "timeout" }),
    JOB,
    "ghlNeighbour01",
  );
  assertEquals(errored, {
    ok: false,
    reason: "lookup_failed",
    message: "timeout",
  });
  const thrown = await findLiveJobContactForGhlContact(
    jobContactsClient([neighbour], { throws: true }),
    JOB,
    "ghlNeighbour01",
  );
  assertEquals(thrown, {
    ok: false,
    reason: "lookup_failed",
    message: "job_contacts read threw",
  });
});

Deno.test("blank ids never match", async () => {
  assertEquals(isLiveJobContactFor(neighbour, JOB, ""), false);
  assertEquals(
    isLiveJobContactFor({ ...neighbour, ghl_contact_id: null }, JOB, "x"),
    false,
  );
  const r = await findLiveJobContactForGhlContact(
    jobContactsClient([neighbour]),
    "",
    "ghlNeighbour01",
  );
  assertEquals(r, { ok: false, reason: "not_on_job" });
});
