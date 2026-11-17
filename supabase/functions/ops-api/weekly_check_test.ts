// deno-lint-ignore-file no-explicit-any
import { strict as assert } from "node:assert";
import { weeklyCheckAction } from "./weekly_check.ts";

const week = "2026-11-16";
const user = { id: "00000000-0000-4000-8000-000000000401" };
const input = (action = "weekly_check_list") => ({
  action,
  method: action === "weekly_check_list" ? "GET" : "POST",
  query: new URLSearchParams(),
  body: {},
  authMode: "jwt",
  user,
  staff: true,
});

function stub(error: any = null) {
  const calls: any[] = [];
  const jobs = Array.from({ length: 20 }, (_, i) => ({
    job_id: `job-${i}`,
    job: { job_number: `ZZTEST-${401 + i}` },
    as_at: "2026-11-16T00:00:00Z",
    story: [],
    notes: [{
      item_key: "note:1",
      what: "Visit arranged",
      closed_how: "record",
    }],
    story_source: "live",
    notes_source: "candidate",
    read_at: null,
    marks: null,
    missing: null,
    page: { contact: "must not leave the store" },
  }));
  const scores = [{ week, drawn: 20, read: 0, word_closes_read: 0 }];
  return {
    calls,
    client: {
      from(table: string) {
        let single = false;
        const q: any = {
          select(columns: string) {
            calls.push({ table, columns });
            return q;
          },
          eq() {
            return q;
          },
          order() {
            return q;
          },
          limit() {
            return q;
          },
          maybeSingle() {
            single = true;
            return q;
          },
          then(resolve: any) {
            return Promise.resolve({
              data: table === "job_truth_weekly_samples"
                ? jobs
                : single
                ? scores[0]
                : scores,
              error: null,
            }).then(resolve);
          },
        };
        return q;
      },
      rpc(name: string, params: any) {
        calls.push({ name, params });
        return Promise.resolve(
          name === "job_truth_weekly_record"
            ? { data: { outcome: "recorded", wrong: 0, of: 1 }, error }
            : { data: null, error: { code: "PGRST202" } },
        );
      },
    },
  };
}

Deno.test("weekly read requires a staff session for both actions", async () => {
  for (const action of ["weekly_check_list", "weekly_check_record"]) {
    const s = stub();
    assert.equal(
      (await weeklyCheckAction(s.client, {
        ...input(action),
        authMode: "api_key",
      })).status,
      401,
    );
    assert.equal(
      (await weeklyCheckAction(s.client, { ...input(action), staff: false }))
        .status,
      403,
    );
    assert.equal(s.calls.length, 0);
  }
});

Deno.test("weekly staff list returns 20 jobs and excludes page and contacts", async () => {
  const s = stub();
  const result = await weeklyCheckAction(s.client, input());
  assert.equal(result.status, 200);
  assert.equal(result.body.jobs.length, 20);
  assert.equal(result.body.week, week);
  assert.equal(result.body.close_shares, null);
  assert.equal(result.body.jobs[0].read, false);
  assert.equal(result.body.jobs[0].notes[0].closed_how, "record");
  assert.equal(result.body.jobs[0].notes_source, "candidate");
  assert.equal(result.body.this_week.word_closes_read, 0);
  for (const job of result.body.jobs) {
    assert.equal("page" in job, false);
    assert.equal("contact" in job, false);
  }
  assert.ok(
    s.calls.filter((c) => c.table === "job_truth_weekly_samples")
      .every((c) => !c.columns.split(",").includes("page")),
  );
});

Deno.test("weekly record uses the session identity and maps database validation", async () => {
  const body = {
    week,
    job_id: "00000000-0000-4000-8000-000000000402",
    user_id: "body-user",
    marks: [],
    missing: [],
  };
  const s = stub();
  assert.equal(
    (await weeklyCheckAction(s.client, {
      ...input("weekly_check_record"),
      body,
    })).status,
    200,
  );
  assert.equal(s.calls[0].params.p_user, user.id);
  for (
    const [code, status, words] of [
      [
        "weekly_record_bad_mark",
        400,
        "That sentence or note is not on this job's list.",
      ],
      [
        "weekly_record_bad_missing",
        400,
        "Each missing line needs 3 to 300 characters, at most 20 lines.",
      ],
      [
        "weekly_record_not_staff",
        403,
        "Only office staff can record a weekly read.",
      ],
    ] as const
  ) {
    const result = await weeklyCheckAction(stub({ message: code }).client, {
      ...input("weekly_check_record"),
      body,
    });
    assert.equal(result.status, status);
    assert.equal(result.body.error, words);
  }
});
