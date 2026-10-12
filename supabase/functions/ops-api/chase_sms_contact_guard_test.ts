// deno-lint-ignore-file no-import-prefix
// sendChaseSms's contact/job match (assertGhlContactMatchesResolvedJob): the job's own
// contact or a live party on the SAME job's contact list (a neighbour on a shared fence,
// Captain ruling 12 Oct 2026). Everything else is refused as before.
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { _assertGhlContactMatchesResolvedJobForTest as guard } from "./index.ts";
import { SesActionError } from "./ses_reporting_actions.ts";
import { guardClient } from "../_shared/job_contact_membership_test_fakes.ts";

const JOB = "10000000-0000-4000-8000-000000000001";
const OTHER_JOB = "10000000-0000-4000-8000-000000000002";
const job = { id: JOB, ghl_contact_id: "ghlPrimary001" };
const neighbour = {
  id: "jc-1",
  job_id: JOB,
  ghl_contact_id: "ghlNeighbour01",
  status: "active",
  removed_at: null,
};

async function refusedWith(
  client: unknown,
  contactId: string,
  status: number,
  jobId: string | null = JOB,
) {
  const error = await assertRejects(
    () => guard(client, jobId, contactId, "send_chase_sms"),
    SesActionError,
  ) as SesActionError;
  assertEquals(error.status, status);
}

Deno.test("chase guard: the job's main contact is allowed", async () => {
  const client = guardClient({ job, contacts: [neighbour] });
  await guard(client, JOB, "ghlPrimary001", "send_chase_sms");
  assertEquals(client.reads, ["jobs"]);
});

Deno.test("chase guard: a neighbour on the same job's contact list is allowed", async () => {
  await guard(
    guardClient({ job, contacts: [neighbour] }),
    JOB,
    "ghlNeighbour01",
    "send_chase_sms",
  );
  // Also when the job has no contact of its own.
  await guard(
    guardClient({
      job: { ...job, ghl_contact_id: null },
      contacts: [neighbour],
    }),
    JOB,
    "ghlNeighbour01",
    "send_chase_sms",
  );
});

Deno.test("chase guard: a neighbour on a different job is refused", async () => {
  await refusedWith(
    guardClient({ job, contacts: [{ ...neighbour, job_id: OTHER_JOB }] }),
    "ghlNeighbour01",
    409,
  );
});

Deno.test("chase guard: a random contact is refused", async () => {
  await refusedWith(
    guardClient({ job, contacts: [neighbour] }),
    "ghlRandom0001",
    409,
  );
  await refusedWith(
    guardClient({ job: { ...job, ghl_contact_id: null }, contacts: [] }),
    "ghlRandom0001",
    409,
  );
});

Deno.test("chase guard: a removed or inactive neighbour row is refused", async () => {
  for (
    const row of [
      { ...neighbour, status: "removed", removed_at: "2026-10-01T00:00:00Z" },
      { ...neighbour, status: "inactive" },
      { ...neighbour, removed_at: "2026-10-01T00:00:00Z" },
    ]
  ) {
    await refusedWith(
      guardClient({ job, contacts: [row] }),
      "ghlNeighbour01",
      409,
    );
  }
});

Deno.test("chase guard: failed reads and a missing job link fail closed", async () => {
  await refusedWith(
    guardClient({ job, contacts: [neighbour], contactsError: "timeout" }),
    "ghlNeighbour01",
    503,
  );
  await refusedWith(
    guardClient({ job, jobError: "timeout" }),
    "ghlPrimary001",
    503,
  );
  await refusedWith(guardClient({ job: null }), "ghlPrimary001", 503);
  await refusedWith(guardClient({ job }), "ghlPrimary001", 409, null);
});
