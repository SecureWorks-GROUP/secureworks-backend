// SQ-23: quote options on one customer decision. Pure parts of the ghl-proxy
// change: mint input rules, the link call and the route A same-site guard.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  fenceSameSiteGuardOn,
  fenceMintFingerprint,
  FenceMintError,
  fenceSiteKey,
  linkFenceQuoteOption,
  openSameSiteFenceJobs,
  validateFenceMintInput,
} from "./fence_mint.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const EXISTING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const base = {
  requestId: "11111111-1111-4111-8111-111111111111",
  organisationId: ORG,
  contactId: "contact-1",
  phone: "0400000000",
  address: "1 Test Street",
  suburb: "Perth",
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof FenceMintError) return e.code;
    throw e;
  }
  return "ok";
}

Deno.test("SQ-23: a quote option rides only on a deliberate repeat, of one of the customer's existing jobs", () => {
  const option = validateFenceMintInput({
    ...base,
    intent: "DELIBERATE_REPEAT",
    repeatReason: "Option B, Colorbond instead of timber",
    expectedExistingJobIds: [EXISTING],
    quoteOptionOfJobId: EXISTING.toUpperCase(),
    optionLabel: "Option B: Colorbond",
  });
  assertEquals(option.quoteOptionOfJobId, EXISTING);
  assertEquals(option.optionLabel, "Option B: Colorbond");
  // A plain repeat (new work) carries no option: genuine repeats stay distinct.
  const repeat = validateFenceMintInput({
    ...base,
    intent: "DELIBERATE_REPEAT",
    repeatReason: "Back fence, new job",
    expectedExistingJobIds: [EXISTING],
  });
  assertEquals(repeat.quoteOptionOfJobId, null);
  assertEquals(repeat.optionLabel, null);
  assertEquals(
    code(() => validateFenceMintInput({ ...base, intent: "RESOLVED_NO_JOB", quoteOptionOfJobId: EXISTING })),
    "quote_option_requires_repeat",
  );
  assertEquals(
    code(() =>
      validateFenceMintInput({
        ...base,
        intent: "DELIBERATE_REPEAT",
        repeatReason: "Option B",
        expectedExistingJobIds: [EXISTING],
        quoteOptionOfJobId: OTHER,
      })
    ),
    "quote_option_not_existing_job",
  );
});

Deno.test("SQ-23: the option does not change the mint fingerprint, so a retried mint stays one job", async () => {
  const common = { ...base, intent: "DELIBERATE_REPEAT", repeatReason: "Option B", expectedExistingJobIds: [EXISTING] };
  const a = await fenceMintFingerprint(validateFenceMintInput(common));
  const b = await fenceMintFingerprint(validateFenceMintInput({ ...common, quoteOptionOfJobId: EXISTING, optionLabel: "B" }));
  assertEquals(a, b);
});

Deno.test("SQ-23: the link returns the group, or a refusal code, and never throws", async () => {
  const calls: any[] = [];
  const ok = await linkFenceQuoteOption({
    rpc: async (name, params) => {
      calls.push([name, params]);
      return { data: EXISTING, error: null };
    },
    jobId: OTHER,
    optionOfJobId: EXISTING,
    label: "B",
    actorId: "actor",
  });
  assertEquals(ok, { ok: true, groupId: EXISTING });
  assertEquals(calls[0][0], "link_fence_quote_option");
  assertEquals(calls[0][1], { p_job_id: OTHER, p_option_of_job_id: EXISTING, p_label: "B", p_actor_id: "actor" });
  const refused = await linkFenceQuoteOption({
    rpc: async () => ({ data: null, error: { code: "22023", message: "quote_option_not_open" } }),
    jobId: OTHER,
    optionOfJobId: EXISTING,
    label: null,
    actorId: "actor",
  });
  assertEquals(refused, { ok: false, code: "quote_option_not_open" });
  const odd = await linkFenceQuoteOption({
    rpc: async () => ({ data: null, error: { message: "network" } }),
    jobId: OTHER,
    optionOfJobId: EXISTING,
    label: null,
    actorId: "actor",
  });
  assertEquals(odd, { ok: false, code: "quote_option_link_failed" });
});

Deno.test("SQ-23 route A: only an open fence job at the same street address stops a new one", () => {
  const jobs = [
    { id: "1", job_number: "SWF-1", status: "quoted", site_address: "1 Test St, Perth WA", site_suburb: "Perth" },
    { id: "2", job_number: "SWF-2", status: "draft", site_address: "1 test st perth wa", site_suburb: null },
    // Same site but won or in hand: not an open quote.
    { id: "3", job_number: "SWF-3", status: "scheduled", site_address: "1 Test St, Perth WA" },
    // Same site but already superseded by an accepted option.
    { id: "4", job_number: "SWF-4", status: "quoted", site_address: "1 Test St, Perth WA", superseded_at: "2026-10-19T00:00:00Z" },
    // Another site for the same customer: new work, never counted.
    { id: "5", job_number: "SWF-5", status: "quoted", site_address: "9 Other Rd, Perth WA" },
    // Same street words in another suburb: another site.
    { id: "6", job_number: "SWF-6", status: "quoted", site_address: "1 Test St, Perth WA", site_suburb: "Bayswater" },
    // A unit on the same street: another site.
    { id: "7", job_number: "SWF-7", status: "quoted", site_address: "1/23 Smith St" },
  ];
  // A suburb on one side only is not a match: job 2 has none.
  assertEquals(openSameSiteFenceJobs(jobs, "1 Test St, Perth WA", "Perth").map((j) => j.id), ["1"]);
  // No suburb on either side: the street address alone decides.
  assertEquals(openSameSiteFenceJobs(jobs, "1 Test St, Perth WA").map((j) => j.id), ["2"]);
  assertEquals(openSameSiteFenceJobs(jobs, "1 Test St, Perth WA", " perth ").map((j) => j.id), ["1"]);
  assertEquals(openSameSiteFenceJobs(jobs, "9 Other Rd Perth WA").map((j) => j.id), ["5"]);
  assertEquals(openSameSiteFenceJobs(jobs, "123 Smith St"), []);
  assertEquals(openSameSiteFenceJobs(jobs, "12 New Ave"), []);
  // No address: no guess, nothing stops the save.
  assertEquals(openSameSiteFenceJobs(jobs, ""), []);
  assertEquals(fenceSiteKey("1/23 Smith St"), "1 23 smith st");
  assert(fenceSiteKey("1/23 Smith St") !== fenceSiteKey("123 Smith St"));
});

Deno.test("SQ-23 route A guard is off unless its switch reads true", async () => {
  assertEquals(await fenceSameSiteGuardOn(() => Promise.resolve({ data: { enabled: true }, error: null })), true);
  assertEquals(await fenceSameSiteGuardOn(() => Promise.resolve({ data: { enabled: false }, error: null })), false);
  assertEquals(await fenceSameSiteGuardOn(() => Promise.resolve({ data: null, error: null })), false);
  assertEquals(await fenceSameSiteGuardOn(() => Promise.resolve({ data: null, error: { message: "x" } })), false);
  assertEquals(await fenceSameSiteGuardOn(() => Promise.reject(new Error("down"))), false);
});

Deno.test("SQ-23: a busy group is its own code, so the scoper retries", async () => {
  const busy = await linkFenceQuoteOption({
    rpc: () => Promise.resolve({ data: null, error: { code: "55P03", message: "quote_option_busy" } }),
    jobId: OTHER,
    optionOfJobId: EXISTING,
    label: null,
    actorId: "actor",
  });
  assertEquals(busy, { ok: false, code: "quote_option_busy" });
});

Deno.test("SQ-23: a link whose call throws is a refusal code, not an exception", async () => {
  const thrown = await linkFenceQuoteOption({
    rpc: () => Promise.reject(new Error("socket hang up")),
    jobId: OTHER,
    optionOfJobId: EXISTING,
    label: null,
    actorId: "actor",
  });
  assertEquals(thrown, { ok: false, code: "quote_option_link_failed" });
});
