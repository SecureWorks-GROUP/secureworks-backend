// Behaviour tests for the M4 link action (captain, 24 Sep 2026: "yes link all
// live jobs to their contacts"), on recorded fixtures of each outcome: certain
// by phone, by email and by both; ambiguous (several contacts, phone and email
// disagree, our own records name another contact or several, an unfinished
// search); none (no key, GHL's fuzzy search returns only near misses); failed
// (a search refused) and a stopping rate limit. The GHL side answers like the
// list_ghl_contacts read; the write is link_job_ghl_contact's outcomes, whose
// never-overwrite rule is proven in the SQL contract.
// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  contactsWithKey,
  LINK_DRY_RUN_SOURCE,
  LINK_RUN_SOURCE,
  type LinkCandidate,
  type LinkDeps,
  type LinkWriteOutcome,
  parseLinkRequest,
  phoneQuery,
  runGhlContactLink,
} from "./link.ts";
import { R21_CONTACT, R21_JOB } from "./m4_fixtures.ts";

const T0 = Date.parse("2026-09-24T02:00:00.000Z");

function job(n: string, extra: Partial<LinkCandidate> = {}): LinkCandidate {
  return {
    job_id: `44444444-4444-4444-8444-4444444${
      n.replace(/\D/g, "").padStart(5, "0")
    }`,
    job_number: n,
    tier: 3,
    phone_key: null,
    email_key: null,
    own_contact_id: null,
    own_contacts: 0,
    ...extra,
  };
}

function harness(
  candidates: LinkCandidate[],
  directory: Record<
    string,
    Record<string, unknown>[] | Error | {
      incomplete: Record<string, unknown>[];
    }
  >,
  writes: Record<string, LinkWriteOutcome> = {},
) {
  const runs: {
    id: string;
    source: string;
    status: string;
    counts: Record<string, number>;
    error_code?: string | null;
    cursor?: unknown;
    updated_at: string;
  }[] = [];
  const pages: (string | null)[] = [];
  const linked: Record<string, unknown>[] = [];
  const queries: string[] = [];
  const deps: LinkDeps = {
    now: () => T0,
    latestRun: (source) =>
      Promise.resolve(
        ([...runs].reverse().find((r) => r.source === source) ?? null) as never,
      ),
    recordRun: (run) => {
      if (run.run_id) {
        const r = runs.find((x) => x.id === run.run_id)!;
        if (run.status) r.status = String(run.status);
        if (run.counts) {
          r.counts = structuredClone(run.counts as Record<string, number>);
        }
        if ("error_code" in run) r.error_code = run.error_code as string | null;
        if ("cursor" in run) r.cursor = structuredClone(run.cursor);
        return Promise.resolve(r.id);
      }
      runs.push({
        id: `run-${runs.length + 1}`,
        source: String(run.source),
        status: "running",
        counts: {},
        cursor: run.cursor,
        updated_at: new Date(T0).toISOString(),
      });
      return Promise.resolve(runs.at(-1)!.id);
    },
    // context_ghl_history_link_candidates' keyset page: the list is in job-id
    // order; a page starts after the given job and holds at most `limit`.
    candidates: (after, limit) => {
      pages.push(after);
      const start = after === null
        ? 0
        : candidates.findIndex((c) => c.job_id === after) + 1;
      return Promise.resolve(candidates.slice(start, start + limit));
    },
    searchContacts: (query) => {
      queries.push(query);
      const hit = directory[query];
      if (hit instanceof Error) return Promise.reject(hit);
      if (hit && !Array.isArray(hit)) {
        return Promise.resolve({ contacts: hit.incomplete, complete: false });
      }
      return Promise.resolve({ contacts: hit ?? [], complete: true });
    },
    link: (row) => {
      linked.push(row);
      return Promise.resolve(
        writes[String(row.job_id)] ?? { outcome: "linked", link_id: "l1" },
      );
    },
  };
  return { deps, runs, linked, queries, pages };
}

const real = { dryRun: false, maxJobs: 500, actor: "m4-test" };
const phone = (key: string) => phoneQuery(key);
const failure = (code: string, status: number, providerStatus?: number) =>
  Object.assign(new Error(code), { code, status, providerStatus });

Deno.test("keys are compared exactly: a fuzzy GHL hit on another number or address never counts", () => {
  const found = contactsWithKey(
    [
      { id: "exactContact0001", phone: "+61412345678" },
      { id: "nearMissContact01", phone: "+61412345679" },
      { id: "ourLineContact001", phone: "+61489267772" },
      { id: "bad id!", phone: "+61412345678" },
    ],
    "phone",
    "412345678",
  );
  assertEquals([...found], ["exactContact0001"]);
  const byMail = contactsWithKey(
    [
      { id: "mailContact00001", email: " R21.Placeholder@Example.com " },
      { id: "mailContact00002", email: "r21.placeholder@example.com.au" },
    ],
    "email",
    "r21.placeholder@example.com",
  );
  assertEquals([...byMail], ["mailContact00001"]);
});

Deno.test("R21 (SWF-26168): one GHL contact by phone and email is certain and is written, with the key kind", async () => {
  const h = harness([R21_JOB], {
    [phone("412345678")]: [{ id: R21_CONTACT, phone: "+61 412 345 678" }],
    "r21.placeholder@example.com": [{
      id: R21_CONTACT,
      email: "r21.placeholder@example.com",
    }],
  });
  const out = await runGhlContactLink(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals(out.counts.certain, 1);
  assertEquals(out.counts.by_phone_and_email, 1);
  assertEquals(out.counts.linked, 1);
  assertEquals(h.linked, [{
    job_id: R21_JOB.job_id,
    contact_id: R21_CONTACT,
    key_kind: "phone_and_email",
    run_id: out.run_id,
    actor: "m4-test",
  }]);
  assertEquals(h.runs[0].source, LINK_RUN_SOURCE);
  assertEquals(h.runs[0].status, "succeeded");
});

Deno.test("certain by one key when the other is absent or unmatched; our own records agreeing is still certain", async () => {
  const h = harness([
    job("M4-P", { phone_key: "400111222" }),
    job("M4-E", {
      email_key: "e.only@example.com",
      own_contact_id: "emailContact0001",
      own_contacts: 1,
    }),
    job("M4-PX", { phone_key: "400333444", email_key: "nobody@example.com" }),
  ], {
    [phone("400111222")]: [{ id: "phoneContact0001", phone: "0400111222" }],
    "e.only@example.com": [{
      id: "emailContact0001",
      email: "e.only@example.com",
    }],
    [phone("400333444")]: [{ id: "phoneContact0002", phone: "+61400333444" }],
    "nobody@example.com": [],
  });
  const out = await runGhlContactLink(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals([out.counts.certain, out.counts.by_phone, out.counts.by_email], [
    3,
    2,
    1,
  ]);
  assertEquals(h.linked.map((r) => r.key_kind), ["phone", "email", "phone"]);
});

Deno.test("ambiguous: several contacts, phone and email disagree, our records disagree or name several, search unfinished", async () => {
  const h = harness([
    job("M4-A1", { phone_key: "400000001" }),
    job("M4-A2", { phone_key: "400000002", email_key: "a2@example.com" }),
    job("M4-A3", {
      phone_key: "400000003",
      own_contact_id: "ourOtherContact1",
      own_contacts: 1,
    }),
    job("M4-A4", { phone_key: "400000004", own_contacts: 2 }),
    job("M4-A5", { phone_key: "400000005" }),
  ], {
    [phone("400000001")]: [{ id: "twinContact00001", phone: "0400000001" }, {
      id: "twinContact00002",
      phone: "+61400000001",
    }],
    [phone("400000002")]: [{ id: "phoneSide0000001", phone: "0400000002" }],
    "a2@example.com": [{ id: "emailSide0000001", email: "a2@example.com" }],
    [phone("400000003")]: [{ id: "ghlSideContact01", phone: "0400000003" }],
    [phone("400000005")]: {
      incomplete: [{ id: "partialContact01", phone: "0400000005" }],
    },
  });
  const out = await runGhlContactLink(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals(out.counts.ambiguous, 5);
  assertEquals([
    out.counts.several_contacts,
    out.counts.phone_email_disagree,
    out.counts.own_records_disagree,
    out.counts.own_records_several,
    out.counts.search_incomplete,
  ], [1, 1, 1, 1, 1]);
  assertEquals(out.ambiguous_job_numbers, [
    "M4-A1",
    "M4-A2",
    "M4-A3",
    "M4-A4",
    "M4-A5",
  ]);
  assertEquals(h.linked.length, 0);
  // Our own records naming several contacts is decided without asking GHL.
  assert(!h.queries.includes(phone("400000004")));
});

Deno.test("none: no usable key, or GHL holds no contact with the exact key", async () => {
  const h = harness([
    job("M4-N1"),
    job("M4-N2", { phone_key: "400000010", email_key: "n2@example.com" }),
  ], {
    [phone("400000010")]: [{ id: "nearMissContact2", phone: "0400000011" }],
    "n2@example.com": [],
  });
  const out = await runGhlContactLink(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals([out.counts.none, out.counts.no_keys, out.counts.not_in_ghl], [
    2,
    1,
    1,
  ]);
  assertEquals(out.none_job_numbers, ["M4-N1", "M4-N2"]);
  assertEquals(h.linked.length, 0);
  assertEquals(h.queries.length, 2); // no key, no search
});

Deno.test("dry run is the default: counts and job numbers, nothing written", async () => {
  assertEquals(parseLinkRequest({}, "a").dryRun, true);
  assertEquals(parseLinkRequest({ dry_run: false }, "a").dryRun, false);
  const h = harness([
    R21_JOB,
    job("M4-N1"),
    job("M4-A1", { phone_key: "400000001" }),
  ], {
    [phone("412345678")]: [{ id: R21_CONTACT, phone: "+61412345678" }],
    "r21.placeholder@example.com": [],
    [phone("400000001")]: [{ id: "twinContact00001", phone: "0400000001" }, {
      id: "twinContact00002",
      phone: "0400000001",
    }],
  });
  const out = await runGhlContactLink(h.deps, parseLinkRequest({}, "m4-test"));
  assert(out.outcome === "ran");
  assertEquals([out.counts.certain, out.counts.ambiguous, out.counts.none], [
    1,
    1,
    1,
  ]);
  assertEquals(out.ambiguous_job_numbers, ["M4-A1"]);
  assertEquals(out.none_job_numbers, ["M4-N1"]);
  assertEquals(out.counts.linked, 0);
  assertEquals(h.linked.length, 0);
  assertEquals(h.runs[0].source, LINK_DRY_RUN_SOURCE);
  // Numbers only: the result carries no key, phone, email or name.
  assert(!JSON.stringify(out).includes("412345678"));
  assert(!JSON.stringify(out).includes("@"));
});

Deno.test("the writer's answer is counted: never an overwrite, not live, booking-draft conflict", async () => {
  const jobs = ["M4-W1", "M4-W2", "M4-W3", "M4-W4"].map((n, i) =>
    job(n, { phone_key: `40000002${i}` })
  );
  const directory = Object.fromEntries(
    jobs.map((
      j,
      i,
    ) => [phone(j.phone_key!), [{
      id: `writeContact000${i}`,
      phone: `04${j.phone_key}`,
    }]]),
  );
  const h = harness(jobs, directory, {
    [jobs[1].job_id]: { outcome: "already_linked", same_contact: false },
    [jobs[2].job_id]: { outcome: "not_live" },
    [jobs[3].job_id]: { outcome: "booking_draft_conflict" },
  });
  const out = await runGhlContactLink(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals([
    out.counts.linked,
    out.counts.already_linked,
    out.counts.not_live,
    out.counts.link_conflicts,
  ], [1, 1, 1, 1]);
  assertEquals(out.ambiguous_job_numbers, ["M4-W4"]);
});

Deno.test("one contact matched to several jobs is counted for review", async () => {
  const h = harness([
    job("M4-S1", { phone_key: "400000031" }),
    job("M4-S2", { phone_key: "400000031" }),
  ], {
    [phone("400000031")]: [{ id: "sharedContact001", phone: "0400000031" }],
  });
  const out = await runGhlContactLink(h.deps, parseLinkRequest({}, "m4-test"));
  assert(out.outcome === "ran");
  assertEquals([out.counts.certain, out.counts.contacts_on_several_jobs], [
    2,
    1,
  ]);
});

Deno.test("a refused search fails that job; a rate limit stops the run with the rest left", async () => {
  const h = harness([
    job("M4-F1", { phone_key: "400000041" }),
    job("M4-F2", { phone_key: "400000042" }),
    job("M4-F3", { phone_key: "400000043" }),
  ], {
    [phone("400000041")]: failure("provider_request_failed", 502, 400),
    [phone("400000042")]: failure("provider_request_failed", 429, 429),
  });
  const out = await runGhlContactLink(h.deps, real);
  assert(out.outcome === "ran");
  assertEquals([out.status, out.error_code], ["failed", "ghl_rate_limited"]);
  assertEquals(out.failed_job_numbers, ["M4-F1"]);
  assertEquals([
    out.counts.failed,
    out.counts.jobs_considered,
    out.counts.backlog_jobs,
  ], [1, 1, 2]);
  assertEquals(h.linked.length, 0);
});

Deno.test("keyset paging: each run starts where the last stopped, so every live job is reached; the end starts over", async () => {
  const jobs = [1, 2, 3, 4, 5].map((i) =>
    job(`M4-K${i}`, { job_id: `55555555-5555-4555-8555-00000000000${i}` })
  );
  const h = harness(jobs, {});
  const page = { ...real, dryRun: true, maxJobs: 2 };
  const first = await runGhlContactLink(h.deps, page);
  assert(first.outcome === "ran");
  assertEquals([first.after_job_id, first.next_after_job_id], [
    null,
    jobs[1].job_id,
  ]);
  assertEquals(first.none_job_numbers, ["M4-K1", "M4-K2"]);
  assertEquals(first.status, "partial"); // more remain
  const second = await runGhlContactLink(h.deps, page);
  assert(second.outcome === "ran");
  assertEquals(second.none_job_numbers, ["M4-K3", "M4-K4"]);
  const third = await runGhlContactLink(h.deps, page);
  assert(third.outcome === "ran");
  assertEquals(third.none_job_numbers, ["M4-K5"]);
  assertEquals(third.next_after_job_id, null); // reached the end
  const fourth = await runGhlContactLink(h.deps, page);
  assert(fourth.outcome === "ran");
  assertEquals(fourth.none_job_numbers, ["M4-K1", "M4-K2"]);
  assertEquals(h.pages, [null, jobs[1].job_id, jobs[3].job_id, null]);
  // The caller can start anywhere; the run row keeps its own cursor.
  const chosen = await runGhlContactLink(h.deps, {
    ...page,
    afterJobId: jobs[2].job_id,
  });
  assert(chosen.outcome === "ran");
  assertEquals(chosen.none_job_numbers, ["M4-K4", "M4-K5"]);
  assertEquals(
    parseLinkRequest({ after_job_id: jobs[2].job_id }, "a").afterJobId,
    jobs[2].job_id,
  );
  assertEquals(
    parseLinkRequest({ after_job_id: "not-a-uuid" }, "a").afterJobId,
    null,
  );
});

Deno.test("a rate limit keeps the cursor at the last job judged, so the next run resumes there", async () => {
  const jobs = [1, 2, 3].map((i) =>
    job(`M4-R${i}`, {
      job_id: `66666666-6666-4666-8666-00000000000${i}`,
      phone_key: `40000005${i}`,
    })
  );
  const h = harness(jobs, {
    [phone("400000052")]: failure("provider_request_failed", 429, 429),
  });
  const out = await runGhlContactLink(h.deps, { ...real, dryRun: true });
  assert(out.outcome === "ran");
  assertEquals([out.status, out.next_after_job_id], ["failed", jobs[0].job_id]);
});
