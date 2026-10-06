// Story slice S2 (contract section 5.4): the job story read doors.
// - assemble_job_dossier mode `story`: the job header plus story and client
//   from context_job_story / context_client_story, none of the heavy reads,
//   no write, no network; a failed story is null with a code, never empty.
// - GET job_story (job_id or job_number, as_of, since, generation_id),
//   client_story and context_story_scorecard (pages folded into rows 11 to 13).
// - All three are staff-only through the existing front door.
// Fake client only; synthetic ids.
// deno-lint-ignore-file no-import-prefix no-explicit-any
import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildStoryDossier,
  clientStoryAction,
  exactJobNumberPattern,
  jobStoryAction,
  parseInstant,
  readJobStory,
  sanitizedError,
  STORY_SECTIONS_VERSION,
  StoryReadError,
  storyScorecardAction,
} from "./job_story_read.ts";
import {
  _assembleJobDossierForTest,
  _authorizeOpsApiAction,
  _opsApiActionNeedsStaffRole,
  AGENT_READ_ALLOWED_ACTIONS,
} from "./index.ts";

const JOB = "a0000000-0000-4000-8000-000000000001";
const GEN = "9a000000-0000-4000-8000-000000000002";

const STORY = {
  version: "job-story-v1",
  job: { id: JOB, job_number: "SWF-T0001" },
  now: {
    line:
      "Scheduled since Fri 2 Oct: next visit install booked Thu 8 Oct. Our move.",
    phase: "scheduled",
  },
  loops: [{ key: "R5_customer_wrote_last:x", rank: 1 }],
  not_known: [{
    what: "Phone calls that were not recorded are not here.",
    why: "",
  }, {
    what: "2 newer messages on this job have not been read by the reader yet.",
    why: "The reader reads new evidence on its own schedule.",
  }],
  // The ledger's own freshness (20261006014000): unread_rows counts what the
  // shown generation's reader has not read; the fact pass's count is gone.
  meta: {
    ledger: {
      status: "live",
      generation_id: GEN,
      evidence_until: "2026-10-05T00:00:00+00:00",
      reader: "luna-ledger:v1",
      items: 3,
      hidden_items: 0,
      unread_rows: 2,
      needs_rebuild: false,
      stale: true,
    },
    sources: {},
    evidence_rows: 12,
    built_at: "2026-10-07T02:00:00Z",
  },
};
const CLIENT = {
  version: "client-story-v1",
  jobs: [{ job_id: JOB }, { job_id: "other" }],
};

/** SQL ILIKE as PostgREST runs it: `*` is `%`, a backslash escapes the next character. */
function ilikeMatches(value: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (ch === "%" || ch === "*") re += "[\\s\\S]*";
    else if (ch === "_") re += "[\\s\\S]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(value);
}

function fakeClient(
  opts: { rpc?: Record<string, any>; failRpc?: Set<string>; jobs?: any[] } = {},
) {
  const reads: string[] = [];
  const patterns: string[] = [];
  const rpcs: { fn: string; args: any }[] = [];
  const writes: string[] = [];
  const jobs = opts.jobs ?? [{
    id: JOB,
    job_number: "SWF-T0001",
    type: "fencing",
    status: "scheduled",
    client_name: "Client T",
    ghl_contact_id: "ctT",
    created_at: "2026-09-01T01:00:00Z",
  }];
  return {
    reads,
    rpcs,
    writes,
    patterns,
    rpc(fn: string, args: any) {
      rpcs.push({ fn, args });
      if (opts.failRpc?.has(fn)) {
        return Promise.resolve({
          data: null,
          error: { message: `${fn} unavailable` },
        });
      }
      const data = opts.rpc?.[fn];
      return Promise.resolve({
        data: typeof data === "function" ? data(args) : data ?? null,
        error: null,
      });
    },
    from(table: string) {
      reads.push(table);
      const filters: Array<(r: any) => boolean> = [];
      let lim: number | null = null;
      const q: any = {};
      for (const m of ["insert", "update", "upsert", "delete"]) {
        q[m] = () => {
          writes.push(`${m}:${table}`);
          throw new Error(`write attempted: ${m} ${table}`);
        };
      }
      q.select = () => q;
      q.eq = (c: string, v: any) => (filters.push((r) => r[c] === v), q);
      q.ilike = (c: string, v: string) => (
        patterns.push(v),
          filters.push((r) => ilikeMatches(String(r[c] ?? ""), v)),
          q
      );
      q.limit = (n: number) => ((lim = n), q);
      const rows = () => {
        const all = (table === "jobs" ? jobs : []).filter((r) =>
          filters.every((f) => f(r))
        );
        return lim == null ? all : all.slice(0, lim);
      };
      q.maybeSingle = () =>
        Promise.resolve({ data: rows()[0] ?? null, error: null });
      q.then = (res: any, rej: any) =>
        Promise.resolve({ data: rows(), error: null }).then(res, rej);
      return q;
    },
  };
}

function noNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("the story doors must not call the network");
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}

Deno.test("dossier mode story: header, story and client, only the two story RPCs, no heavy reads, no writes", async () => {
  const client = fakeClient({
    rpc: { context_job_story: STORY, context_client_story: CLIENT },
  });
  const d: any = await noNetwork(() =>
    _assembleJobDossierForTest(client, { job_id: JOB, mode: "story" })
  );
  assertEquals(client.writes, []);
  assertEquals(client.reads, ["jobs"]);
  assertEquals(client.rpcs.map((r) => r.fn).sort(), [
    "context_client_story",
    "context_job_story",
  ]);
  assertEquals(client.rpcs.find((r) => r.fn === "context_job_story")!.args, {
    p_job_id: JOB,
  });
  assertEquals(d.mode, "story");
  assertEquals(d.sections_version, 5);
  assertEquals(STORY_SECTIONS_VERSION, 5);
  assertEquals(d._kind, "job_dossier_v1");
  assertEquals(d.job.job_number, "SWF-T0001");
  assertEquals(d.story.now.line, STORY.now.line);
  assertEquals(d.client.jobs.length, 2);
  assertEquals(d.diagnostics.ok, true);
  assertEquals(d.conversation, undefined);
  assertEquals(d.facts, undefined);
});

Deno.test("dossier mode story passes as_of, since and generation_id; refuses a malformed one", async () => {
  const client = fakeClient({
    rpc: { context_job_story: STORY, context_client_story: CLIENT },
  });
  await _assembleJobDossierForTest(client, {
    job_number: "swf-t0001",
    mode: "story",
    as_of: "2026-10-04T02:00:00Z",
    since: "2026-10-03T12:00:00Z",
    generation_id: GEN,
  });
  assertEquals(client.rpcs.find((r) => r.fn === "context_job_story")!.args, {
    p_job_id: JOB,
    p_as_of: "2026-10-04T02:00:00.000Z",
    p_generation_id: GEN,
    p_since: "2026-10-03T12:00:00.000Z",
  });
  assertEquals(client.rpcs.find((r) => r.fn === "context_client_story")!.args, {
    p_job_id: JOB,
    p_as_of: "2026-10-04T02:00:00.000Z",
  });
  const e = await assertRejects(
    () =>
      _assembleJobDossierForTest(fakeClient(), {
        job_id: JOB,
        mode: "story",
        as_of: "not a date",
      }),
    StoryReadError,
  );
  assertEquals([e.code, e.status], ["invalid_as_of", 400]);
});

Deno.test("a failed story read is null with a code, never an empty story", async () => {
  const client = fakeClient({
    rpc: { context_client_story: CLIENT },
    failRpc: new Set(["context_job_story"]),
  });
  const d: any = await buildStoryDossier(client, {
    id: JOB,
    job_number: "SWF-T0001",
  }, {});
  assertEquals(d.story, null);
  assertEquals(d.diagnostics.ok, false);
  assertEquals(d.diagnostics.sourceStatus.story.code, "rpc_failed");
  assertEquals(d.client.version, "client-story-v1");
  const wrong = await readJobStory(
    fakeClient({ rpc: { context_job_story: { version: "other" } } }),
    { jobId: JOB },
  );
  assertEquals([wrong.story, wrong.status.code], [null, "invalid_shape"]);
  const none = await readJobStory(fakeClient({ rpc: {} }), { jobId: JOB });
  assertEquals([none.story, none.status.code], [null, "empty_payload"]);
});

Deno.test("GET job_story resolves job_number, passes the options, and maps errors", async () => {
  const client = fakeClient({ rpc: { context_job_story: STORY } });
  const s: any = await jobStoryAction(
    client,
    new URLSearchParams("job_number=SWF-T0001&since=2026-10-04T12:00:00Z"),
  );
  assertEquals(s.version, "job-story-v1");
  assertEquals(client.rpcs[0].args, {
    p_job_id: JOB,
    p_since: "2026-10-04T12:00:00.000Z",
  });
  // The door passes the ledger freshness through as the SQL built it.
  assertEquals(s.meta.ledger, STORY.meta.ledger);
  assertEquals(Object.keys(s.meta.ledger).sort(), [
    "evidence_until",
    "generation_id",
    "hidden_items",
    "items",
    "needs_rebuild",
    "reader",
    "stale",
    "status",
    "unread_rows",
  ]);
  assertEquals("unread_rows" in s.meta, false);
  assertEquals(client.writes, []);
  const missing = await assertRejects(
    () =>
      jobStoryAction(fakeClient(), new URLSearchParams("job_number=SWF-NOPE")),
    StoryReadError,
  );
  assertEquals([missing.code, missing.status], ["job_not_found", 404]);
  const none = await assertRejects(
    () => jobStoryAction(fakeClient(), new URLSearchParams("")),
    StoryReadError,
  );
  assertEquals([none.code, none.status], ["job_required", 400]);
  const badGen = await assertRejects(
    () =>
      jobStoryAction(
        fakeClient(),
        new URLSearchParams(`job_id=${JOB}&generation_id=12`),
      ),
    StoryReadError,
  );
  assertEquals(badGen.code, "invalid_generation_id");
  // The records alone are for the ledger reader's own prompt (an RPC
  // argument): the staff door never forwards record_only.
  const recordOnly = fakeClient({ rpc: { context_job_story: STORY } });
  await jobStoryAction(
    recordOnly,
    new URLSearchParams(`job_id=${JOB}&record_only=true`),
  );
  assertEquals(recordOnly.rpcs[0].args, { p_job_id: JOB });
  const failing = await assertRejects(
    () =>
      jobStoryAction(
        fakeClient({ failRpc: new Set(["context_job_story"]) }),
        new URLSearchParams(`job_id=${JOB}`),
      ),
    StoryReadError,
  );
  assertEquals([failing.code, failing.status], ["rpc_failed", 502]);
  // The caller never sees the database's own words (they go to the server log).
  assertEquals(failing.message.includes("unavailable"), false);
});

Deno.test("an instant more than five minutes ahead is refused; a few minutes of skew is not", () => {
  const now = Date.parse("2026-10-05T10:00:00Z");
  const e = (() => {
    try {
      parseInstant("2026-10-05T10:06:00Z", "as_of", now);
    } catch (x) {
      return x as StoryReadError;
    }
    return null;
  })();
  assertEquals([e?.code, e?.status], ["invalid_as_of", 400]);
  assertEquals(
    parseInstant("2026-10-05T10:04:00Z", "as_of", now),
    "2026-10-05T10:04:00.000Z",
  );
  assertEquals(
    parseInstant("2026-10-01T00:00:00Z", "since", now),
    "2026-10-01T00:00:00.000Z",
  );
});

Deno.test("failed reads carry a fixed message and the SQLSTATE, never the database text", async () => {
  const client = fakeClient({ rpc: { context_client_story: CLIENT } });
  client.rpc = (fn: string, args: any) => {
    client.rpcs.push({ fn, args });
    return Promise.resolve({
      data: null,
      error: {
        message: 'relation "secret_table" does not exist',
        code: "42P01",
      },
    });
  };
  const read = await readJobStory(client, { jobId: JOB });
  assertEquals(read.status.code, "rpc_failed");
  assertEquals(read.status.error, "story read failed (42P01)");
  assertEquals(
    sanitizedError("x", { message: "boom", code: "not a state" }),
    "x",
  );
});

Deno.test("job_number is matched exactly and case-insensitively: LIKE wildcards never pick another job", async () => {
  const jobs = [
    { id: JOB, job_number: "SWF-T0001", ghl_contact_id: "ctT" },
    {
      id: "a0000000-0000-4000-8000-000000000009",
      job_number: "SWF 2614",
      ghl_contact_id: null,
    },
  ];
  const story = (n: string) =>
    jobStoryAction(
      fakeClient({ jobs, rpc: { context_job_story: STORY } }),
      new URLSearchParams({ job_number: n }),
    );
  // Exact, any case, spaces kept: these resolve.
  for (const n of ["SWF-T0001", "swf-t0001", " Swf-T0001 "]) {
    assertEquals((await story(n) as any).version, "job-story-v1", n);
  }
  const spaced = fakeClient({ jobs, rpc: { context_job_story: STORY } });
  await jobStoryAction(spaced, new URLSearchParams({ job_number: "swf 2614" }));
  assertEquals(spaced.rpcs[0].args.p_job_id, jobs[1].id);
  // Wildcards are escaped, so they match nothing (no job number holds one).
  for (const n of ["SWF-T000_", "%", "SWF-%", "_WF-T0001", "SWF-T0001%"]) {
    const client = fakeClient({ jobs, rpc: { context_job_story: STORY } });
    const err = await assertRejects(
      () => jobStoryAction(client, new URLSearchParams({ job_number: n })),
      StoryReadError,
    );
    assertEquals([err.code, err.status], ["job_not_found", 404], n);
    assertEquals(client.rpcs, [], n);
  }
  assertEquals(exactJobNumberPattern("SWF-T000_"), "SWF-T000\\_");
  assertEquals(exactJobNumberPattern("50%\\"), "50\\%\\\\");
  // PostgREST reads * as % and cannot escape it: refused before any read.
  const star = fakeClient({ jobs });
  const err = await assertRejects(
    () =>
      jobStoryAction(star, new URLSearchParams({ job_number: "SWF-T000*" })),
    StoryReadError,
  );
  assertEquals([err.code, err.status], ["invalid_job_number", 400]);
  assertEquals(star.reads, []);
  // Whatever the database matched, only an exact number counts.
  const loose = fakeClient({ jobs, rpc: { context_job_story: STORY } });
  loose.from = (() => {
    const q: any = {
      select: () => q,
      ilike: () => q,
      limit: () => q,
      then: (res: any, rej: any) =>
        Promise.resolve({ data: [jobs[0]], error: null }).then(res, rej),
    };
    return q;
  }) as any;
  const e2 = await assertRejects(
    () => jobStoryAction(loose, new URLSearchParams({ job_number: "SWF-T00" })),
    StoryReadError,
  );
  assertEquals(e2.code, "job_not_found");
  // client_story resolves the same way.
  const c = fakeClient({ jobs, rpc: { context_client_story: CLIENT } });
  const e3 = await assertRejects(
    () =>
      clientStoryAction(c, new URLSearchParams({ job_number: "SWF-T000_" })),
    StoryReadError,
  );
  assertEquals(e3.code, "job_not_found");
  assertEquals(c.patterns, ["SWF-T000\\_"]);
});

Deno.test("GET client_story returns client-story-v1 for the job", async () => {
  const client = fakeClient({ rpc: { context_client_story: CLIENT } });
  const c: any = await clientStoryAction(
    client,
    new URLSearchParams(`job_id=${JOB}`),
  );
  assertEquals(c.jobs.length, 2);
  assertEquals(client.rpcs[0], {
    fn: "context_client_story",
    args: { p_job_id: JOB },
  });
});

Deno.test("GET context_story_scorecard folds every per-job page into rows 11 to 13", async () => {
  const rows = Array.from(
    { length: 14 },
    (_, i) => ({
      row: i + 1,
      name: `r${i + 1}`,
      green: null,
      value: "",
      target: "",
      detail: "",
    }),
  );
  const page1 = {
    jobs: [
      {
        job_id: "j1",
        timeline_rows: 5,
        ledger: "live",
        record_loops: 2,
        candidates: 1,
        checks: 3,
        row11_green: true,
        row12_green: true,
        row13_green: true,
        ledger_needs_person: false,
      },
      {
        job_id: "j2",
        timeline_rows: 1,
        ledger: "none",
        record_loops: 0,
        candidates: 0,
        checks: 1,
        row11_green: false,
        row12_green: false,
        row13_green: true,
        ledger_needs_person: true,
      },
    ],
    next: "j2",
  };
  const page2 = {
    jobs: [{
      job_id: "j3",
      timeline_rows: 3,
      ledger: "none",
      record_loops: 1,
      candidates: 0,
      checks: 0,
      row11_green: false,
      row12_green: false,
      row13_green: false,
    }],
    next: null,
  };
  const client = fakeClient({
    rpc: {
      context_story_scorecard: {
        version: "story-scorecard-v1",
        live_jobs: 3,
        rows,
        per_job: { page_size: 150 },
      },
      context_story_scorecard_jobs: (
        args: any,
      ) => (args.p_after ? page2 : page1),
    },
  });
  const card: any = await storyScorecardAction(client, new URLSearchParams(""));
  assertEquals(card.per_job.pages, 2);
  assertEquals(card.per_job.complete, true);
  assertEquals(card.per_job.jobs_read, 3);
  const r = (n: number) => card.rows.find((x: any) => x.row === n);
  assertEquals(r(11).green, false);
  assertEquals(
    r(11).value,
    "1 of 3 live jobs have a timeline and a live ledger with phase notes",
  );
  assertEquals(
    r(12).value,
    "1 of 3 live jobs have a live ledger (promises and asks come from the words)",
  );
  assertEquals(r(13).value, "2 of 3 live jobs can be matched to their client");
  assertEquals(
    r(12).detail,
    "3 record loops, 1 candidates, 4 checks across live jobs; 1 need a person (three ledger readings in a row failed their checks)",
  );
  assertEquals(r(1).name, "r1");
  assertEquals(client.rpcs.map((x) => x.fn), [
    "context_story_scorecard",
    "context_story_scorecard_jobs",
    "context_story_scorecard_jobs",
  ]);
  assertEquals(client.rpcs[2].args, { p_after: "j2", p_limit: 150 });
});

Deno.test("the three story doors are staff-only: not profile-scoped, not agent-read, trades refused", () => {
  for (
    const action of ["job_story", "client_story", "context_story_scorecard"]
  ) {
    const url = new URL(`https://example.invalid/ops-api?action=${action}`);
    assertEquals(_opsApiActionNeedsStaffRole(url), true, action);
    assertEquals(AGENT_READ_ALLOWED_ACTIONS.has(action), false, action);
    const decide = (
      authMode: "api_key" | "jwt",
      role?: string,
      managedVerticals?: string[],
    ) => {
      const d = _authorizeOpsApiAction({
        url,
        authMode,
        authUser: role ? { role, managedVerticals } : null,
        serverSecretPresented: authMode === "api_key",
      });
      return d.ok ? 200 : d.status;
    };
    assertEquals(decide("jwt", "admin"), 200, action);
    assertEquals(decide("jwt", "owner"), 200, action);
    assertEquals(decide("jwt", "ops_manager"), 200, action);
    assertEquals(decide("api_key"), 200, action);
    assertEquals(decide("jwt", "lead_installer", ["fencing"]), 403, action);
    assertEquals(decide("jwt", "trade"), 403, action);
  }
});

Deno.test("the dispatch routes the three doors as GET-only reads", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(index.includes("case 'job_story':"));
  assert(index.includes("case 'client_story':"));
  assert(index.includes("case 'context_story_scorecard': {"));
  assert(
    index.includes(
      "if (req.method !== 'GET') return json({ error: `${action} requires GET` }, 405)",
    ),
  );
  assert(
    index.includes(
      "story:            { conversation: 0,   events: 0,   facts: 0 },",
    ),
  );
});

Deno.test("the deploy probes refuse before any read: a bad job_id or as_of reads nothing", async () => {
  for (
    const [door, params, code] of [
      [jobStoryAction, "job_id=__deploy_probe__", "invalid_job_id"],
      [clientStoryAction, "job_id=__deploy_probe__", "invalid_job_id"],
      [storyScorecardAction, "as_of=__deploy_probe__", "invalid_as_of"],
    ] as const
  ) {
    const client = fakeClient({ rpc: {} });
    const err = await assertRejects(
      () => noNetwork(() => (door as any)(client, new URLSearchParams(params))),
      StoryReadError,
    );
    assertEquals((err as StoryReadError).code, code);
    assertEquals((err as StoryReadError).status, 400);
    assertEquals(client.reads, []);
    assertEquals(client.rpcs, []);
  }
});
