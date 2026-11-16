// deno-lint-ignore-file no-import-prefix no-explicit-any
// Ruling 18 K2: the sealed-send guard, with a fake database and fetch.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  bindQuoteDocumentRevision,
  isSealedQuoteCopyPath,
  judgeSealedSend,
  linkDocumentsToSealedCopy,
  onOwnStorage,
  pinSealedQuotePdf,
  quoteDocumentRevisionToRecord,
  recordSealedSendMiss,
  SEALED_REVISION_REQUIRED_WORDS,
  SEALED_REVISION_SEND_FLAG,
  SEALED_SEND_MISS_REASONS,
  SEALED_SEND_MISSES_TABLE,
  sealedSendCaller,
} from "./sealed_send_guard.ts";
import type { SealedSendSource } from "./quote_scope_revision_link.ts";

const JOB = "11111111-1111-4111-8111-111111111111";
const REV = "22222222-2222-4222-8222-222222222222";
const OLDER = "33333333-3333-4333-8333-333333333333";
const STORAGE = "https://project.supabase.example";
const PDF_A = `${STORAGE}/storage/v1/object/public/job-pdfs/org/job/quote_run_a.pdf`;
const PDF_B = `${STORAGE}/storage/v1/object/public/job-pdfs/org/job/quote_run_b.pdf`;

async function sha(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const BYTES_A = new TextEncoder().encode("%PDF-1.4 run A");
const BYTES_B = new TextEncoder().encode("%PDF-1.4 run B");

type World = {
  flag?: boolean | "error" | "missing";
  newest?: string | null | "error";
  recordedPdfs?: string[] | "error";
  revisions?: Record<string, { job_id: string; status: string }>;
  insertError?: boolean;
};

function fakeDb(world: World) {
  const reads: string[] = [];
  const inserts: Array<{ table: string; row: any }> = [];
  const updates: Array<{ table: string; patch: any; id: unknown }> = [];
  const rpcs: string[] = [];
  const sb = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const q: any = {
        select() {
          reads.push(table);
          return q;
        },
        eq(col: string, v: unknown) {
          filters[col] = v;
          return q;
        },
        order() {
          return q;
        },
        limit() {
          if (table === "scope_revisions") {
            if (world.newest === "error") return Promise.resolve({ data: null, error: { code: "x" } });
            return Promise.resolve({ data: world.newest ? [{ id: world.newest }] : [], error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
        maybeSingle() {
          if (table === "feature_flags") {
            assertEquals(filters.flag_name, SEALED_REVISION_SEND_FLAG);
            if (world.flag === "error") return Promise.resolve({ data: null, error: { code: "x" } });
            if (world.flag === "missing" || world.flag === undefined) return Promise.resolve({ data: null, error: null });
            return Promise.resolve({ data: { enabled: world.flag }, error: null });
          }
          if (table === "scope_revisions") {
            const row = world.revisions?.[String(filters.id)];
            return Promise.resolve({ data: row ? { id: filters.id, ...row } : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        insert(row: any) {
          inserts.push({ table, row });
          return Promise.resolve({ error: world.insertError ? { code: "42501" } : null });
        },
        update(patch: any) {
          return {
            eq(_c: string, id: unknown) {
              updates.push({ table, patch, id });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
      return q;
    },
    rpc(name: string, args: any) {
      rpcs.push(name);
      assertEquals(args.p_scope_revision_id, REV);
      if (world.recordedPdfs === "error") return Promise.resolve({ data: null, error: { code: "x" } });
      return Promise.resolve({ data: world.recordedPdfs ?? [], error: null });
    },
  };
  return { sb, reads, inserts, updates, rpcs };
}

const fetches: string[] = [];
const fakeFetch = ((url: string) => {
  fetches.push(url);
  if (url === PDF_A) return Promise.resolve(new Response(BYTES_A));
  if (url === PDF_B) return Promise.resolve(new Response(BYTES_B));
  return Promise.resolve(new Response("nope", { status: 404 }));
}) as unknown as typeof fetch;

const legacy: SealedSendSource = { kind: "legacy" };
function sealed(sealedFlag: unknown = true, id = REV): SealedSendSource {
  return {
    kind: "sealed",
    revision_id: id,
    scope_json: {},
    pricing_json: { revision: { sealed: sealedFlag, id } },
  } as SealedSendSource;
}
const refused: SealedSendSource = { kind: "refused", status: 409, body: { error: "x", code: "y", reason: "z" } } as any;

const goodWorld = async (): Promise<World> => ({
  flag: true,
  newest: REV,
  recordedPdfs: [await sha(BYTES_A), await sha(BYTES_B)],
});

// ── each refusal reason with the switch on ──

Deno.test("switch on, /send: no named revision is refused with the ruling K words", async () => {
  const db = fakeDb({ flag: true, newest: REV });
  const g = await judgeSealedSend(db.sb, { path: "send", job_id: JOB, job_type: "fencing", sealed: legacy, document: {} }, { storageBaseUrl: STORAGE });
  assert(g.kind === "miss");
  assertEquals(g.switch_on, true);
  assertEquals(g.reason, "no_named_revision");
  assertEquals(g.status, 409);
  assertEquals(g.body.code, "sealed_revision_required");
  assertEquals(g.body.error, SEALED_REVISION_REQUIRED_WORDS);
  assertEquals(
    SEALED_REVISION_REQUIRED_WORDS,
    "Nothing was sent. This page is out of date or the quote is not sealed. Open the Scope Engine, seal and save the quote, then send.",
  );
  assert(!/—/.test(g.body.error), "no em dash in staff words");
});

Deno.test("switch on: a named revision whose frozen pricing is not sealed is refused", async () => {
  const noRevision = { kind: "sealed", revision_id: REV, scope_json: {}, pricing_json: {} } as SealedSendSource;
  for (const s of [sealed(false), sealed("true"), sealed(null), noRevision]) {
    const g = await judgeSealedSend(fakeDb({ flag: true, newest: REV }).sb, {
      path: "send", job_id: JOB, job_type: "patio", sealed: s, document: { scope_revision_id: REV },
    }, { storageBaseUrl: STORAGE });
    assert(g.kind === "miss" && g.reason === "revision_not_sealed" && g.switch_on);
    assertEquals(g.named_scope_revision_id, REV);
  }
});

Deno.test("switch on: a sealed revision that is not the newest frozen one is refused", async () => {
  const g = await judgeSealedSend(fakeDb({ flag: true, newest: OLDER }).sb, {
    path: "send", job_id: JOB, job_type: "fencing", sealed: sealed(), document: { scope_revision_id: REV },
  }, { storageBaseUrl: STORAGE });
  assert(g.kind === "miss" && g.reason === "revision_not_newest" && g.status === 409);
  const none = await judgeSealedSend(fakeDb({ flag: true, newest: null }).sb, {
    path: "send", job_id: JOB, job_type: "fencing", sealed: sealed(), document: { scope_revision_id: REV },
  }, { storageBaseUrl: STORAGE });
  assert(none.kind === "miss" && none.reason === "revision_not_newest");
});

Deno.test("switch on, /send: a document with no recorded revision, or another revision, is refused", async () => {
  const w = await goodWorld();
  const unrecorded = await judgeSealedSend(fakeDb(w).sb, {
    path: "send", job_id: JOB, job_type: "fencing", sealed: sealed(), document: { scope_revision_id: null },
  }, { storageBaseUrl: STORAGE });
  assert(unrecorded.kind === "miss" && unrecorded.reason === "document_revision_unrecorded");
  const other = await judgeSealedSend(fakeDb(w).sb, {
    path: "send", job_id: JOB, job_type: "fencing", sealed: sealed(), document: { scope_revision_id: OLDER },
  }, { storageBaseUrl: STORAGE });
  assert(other.kind === "miss" && other.reason === "document_revision_mismatch");
});

Deno.test("switch on, /send-runs: a run PDF that is not one recorded on the revision is refused", async () => {
  const w = await goodWorld();
  w.recordedPdfs = [await sha(BYTES_A)];
  const g = await judgeSealedSend(fakeDb(w).sb, {
    path: "send-runs", job_id: JOB, job_type: "fencing", sealed: sealed(), run_pdfs: { A: PDF_A, B: PDF_B },
  }, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
  assert(g.kind === "miss" && g.reason === "run_pdf_not_from_revision" && g.status === 409);
});

Deno.test("switch on, /send-runs: a run PDF off our own storage is refused and never fetched", async () => {
  const w = await goodWorld();
  fetches.length = 0;
  const g = await judgeSealedSend(fakeDb(w).sb, {
    path: "send-runs", job_id: JOB, job_type: "fencing", sealed: sealed(),
    run_pdfs: { A: "https://elsewhere.example/storage/v1/object/public/job-pdfs/a.pdf" },
  }, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
  assert(g.kind === "miss" && g.reason === "run_pdf_not_from_revision");
  assertEquals(fetches, []);
});

Deno.test("switch on: a read that fails refuses with 503, nothing sent", async () => {
  const newest = await judgeSealedSend(fakeDb({ flag: true, newest: "error" }).sb, {
    path: "send", job_id: JOB, job_type: "fencing", sealed: sealed(), document: { scope_revision_id: REV },
  }, { storageBaseUrl: STORAGE });
  assert(newest.kind === "miss" && newest.reason === "check_unreadable" && newest.status === 503);
  assertEquals(newest.body.code, "sealed_revision_check_failed");
  const w = await goodWorld();
  w.recordedPdfs = "error";
  const pdfs = await judgeSealedSend(fakeDb(w).sb, {
    path: "send-runs", job_id: JOB, job_type: "fencing", sealed: sealed(), run_pdfs: { A: PDF_A },
  }, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
  assert(pdfs.kind === "miss" && pdfs.reason === "check_unreadable");
  const w2 = await goodWorld();
  const missing = await judgeSealedSend(fakeDb(w2).sb, {
    path: "send-runs", job_id: JOB, job_type: "fencing", sealed: sealed(),
    run_pdfs: { A: `${STORAGE}/storage/v1/object/public/job-pdfs/gone.pdf` },
  }, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
  assert(missing.kind === "miss" && missing.reason === "check_unreadable");
});

// ── switch off: judged the same, nothing refused, recorded ──

Deno.test("switch off (missing, false or unreadable): the same misses, marked switch_on false", async () => {
  for (const flag of ["missing", false, "error"] as const) {
    const g = await judgeSealedSend(fakeDb({ flag, newest: REV }).sb, {
      path: "send", job_id: JOB, job_type: "fencing", sealed: legacy, document: {},
    }, { storageBaseUrl: STORAGE });
    assert(g.kind === "miss" && g.reason === "no_named_revision");
    assertEquals(g.switch_on, false, `flag ${flag} reads as off`);
  }
});

Deno.test("a miss is recorded with ids, codes and the calling page only", async () => {
  const db = fakeDb({ flag: false, newest: REV });
  const g = await judgeSealedSend(db.sb, { path: "send", job_id: JOB, job_type: "fencing", sealed: legacy, document: {} }, { storageBaseUrl: STORAGE });
  assert(g.kind === "miss");
  const req = new Request("https://fn.example/send-quote/send", {
    method: "POST",
    headers: {
      origin: "https://pages.example",
      referer: "https://pages.example/fence.html?job=SWF-1&token=secret#x",
    },
  });
  const body = { document_id: "d", client_email: "someone@example.test", client_name: "A Person", message: "hi" };
  const ok = await recordSealedSendMiss(db.sb, g, {
    job_id: JOB, path: "send", document_id: "44444444-4444-4444-8444-444444444444",
    sender_mode: "jwt", sender_user_id: "55555555-5555-4555-8555-555555555555",
    caller: sealedSendCaller(req, body),
  });
  assert(ok);
  assertEquals(db.inserts.length, 1);
  assertEquals(db.inserts[0].table, SEALED_SEND_MISSES_TABLE);
  const row = db.inserts[0].row;
  assertEquals(row.reason, "no_named_revision");
  assertEquals(row.switch_on, false);
  assertEquals(row.caller_origin, "https://pages.example");
  assertEquals(row.caller_referer, "https://pages.example/fence.html");
  assertEquals(row.body_keys, ["client_email", "client_name", "document_id", "message"]);
  const text = JSON.stringify(row);
  for (const secret of ["someone@example.test", "A Person", "secret", "SWF-1", "hi\""]) {
    assert(!text.includes(secret), `no customer detail or token in the row: ${secret}`);
  }
});

Deno.test("a miss row that cannot be written never throws", async () => {
  const db = fakeDb({ flag: false, insertError: true });
  const g = await judgeSealedSend(db.sb, { path: "send", job_id: JOB, job_type: "fencing", sealed: legacy, document: {} }, { storageBaseUrl: STORAGE });
  assert(g.kind === "miss");
  const ok = await recordSealedSendMiss(db.sb, g, {
    job_id: JOB, path: "send", document_id: null, sender_mode: "api_key", sender_user_id: null,
    caller: { origin: null, referer: null, body_keys: [] },
  });
  assertEquals(ok, false);
});

// ── a sealed newest revision with its own PDF sends in both modes ──

Deno.test("sealed newest revision with its own PDF passes, switch on and off, and hands back the checked bytes", async () => {
  for (const flag of [true, false]) {
    const w = await goodWorld();
    w.flag = flag;
    const send = await judgeSealedSend(fakeDb(w).sb, {
      path: "send", job_id: JOB, job_type: "fencing", sealed: sealed(),
      document: { scope_revision_id: REV, pdf_url: PDF_A },
    }, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
    assert(send.kind === "pass" && send.switch_on === flag);
    assertEquals(send.verified_pdf?.sha256, await sha(BYTES_A));
    assertEquals(send.verified_pdf?.bytes, BYTES_A);
    const runs = await judgeSealedSend(fakeDb(w).sb, {
      path: "send-runs", job_id: JOB, job_type: "patio", sealed: sealed(), run_pdfs: { A: PDF_A, B: PDF_B },
    }, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
    assert(runs.kind === "pass" && runs.switch_on === flag);
    assertEquals([...runs.verified_run_pdfs!.keys()], ["A", "B"]);
    assertEquals(runs.verified_run_pdfs!.get("B")?.bytes, BYTES_B, "run B carries run B's checked bytes");
    const noRunPdfs = await judgeSealedSend(fakeDb(w).sb, {
      path: "send-runs", job_id: JOB, job_type: "fencing", sealed: sealed(),
    }, { storageBaseUrl: STORAGE });
    assert(noRunPdfs.kind === "pass" && noRunPdfs.switch_on === flag && noRunPdfs.verified_run_pdfs?.size === 0);
  }
});

Deno.test("switch on, /send: a matching label is not enough; the linked PDF must be one the revision recorded", async () => {
  const w = await goodWorld();
  w.recordedPdfs = [await sha(BYTES_A)];
  // The document says it was prepared for the revision, but PDF B was
  // uploaded over its address (an overwritten or reused upload).
  const overwritten = await judgeSealedSend(fakeDb(w).sb, {
    path: "send", job_id: JOB, job_type: "fencing", sealed: sealed(),
    document: { scope_revision_id: REV, pdf_url: PDF_B },
  }, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
  assert(overwritten.kind === "miss" && overwritten.reason === "document_pdf_not_from_revision");
  assertEquals(overwritten.status, 409);
  assertEquals(overwritten.body.code, "sealed_revision_required");
  // Nothing recorded on the revision yet: no PDF can be shown to be its own.
  const w2 = await goodWorld();
  w2.recordedPdfs = [];
  const nothingRecorded = await judgeSealedSend(fakeDb(w2).sb, {
    path: "send", job_id: JOB, job_type: "fencing", sealed: sealed(),
    document: { scope_revision_id: REV, pdf_url: PDF_A },
  }, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
  assert(nothingRecorded.kind === "miss" && nothingRecorded.reason === "document_pdf_not_from_revision");
  fetches.length = 0;
  for (const pdf_url of [null, "https://elsewhere.example/storage/v1/object/public/job-pdfs/a.pdf"]) {
    const off = await judgeSealedSend(fakeDb(await goodWorld()).sb, {
      path: "send", job_id: JOB, job_type: "fencing", sealed: sealed(), document: { scope_revision_id: REV, pdf_url },
    }, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
    assert(off.kind === "miss" && off.reason === "document_pdf_not_from_revision");
  }
  assertEquals(fetches, [], "no address outside our storage is fetched");
  const w3 = await goodWorld();
  w3.recordedPdfs = "error";
  const unreadable = await judgeSealedSend(fakeDb(w3).sb, {
    path: "send", job_id: JOB, job_type: "fencing", sealed: sealed(), document: { scope_revision_id: REV, pdf_url: PDF_A },
  }, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
  assert(unreadable.kind === "miss" && unreadable.reason === "check_unreadable" && unreadable.status === 503);
});

// ── switch on: the customer gets only the checked bytes ──

function fakeStorage(existing: Map<string, Uint8Array>, uploadError = false) {
  const uploads: Array<{ path: string; upsert: unknown }> = [];
  const sb = {
    storage: {
      from(bucket: string) {
        assertEquals(bucket, "job-pdfs");
        return {
          upload(path: string, bytes: Uint8Array, opts: any) {
            uploads.push({ path, upsert: opts?.upsert });
            if (uploadError || existing.has(path)) return Promise.resolve({ error: { statusCode: "409" } });
            existing.set(path, bytes);
            return Promise.resolve({ error: null });
          },
          getPublicUrl(path: string) {
            return { data: { publicUrl: `${STORAGE}/storage/v1/object/public/job-pdfs/${path}` } };
          },
        };
      },
    },
  };
  const read = ((url: string) => {
    const path = url.split("/job-pdfs/")[1];
    const bytes = existing.get(path);
    return Promise.resolve(bytes ? new Response(bytes as BodyInit) : new Response("", { status: 404 }));
  }) as unknown as typeof fetch;
  return { sb, uploads, read };
}

Deno.test("pinning stores the checked bytes once, at their content address, never overwriting", async () => {
  const shaA = await sha(BYTES_A);
  const store = fakeStorage(new Map());
  const first = await pinSealedQuotePdf(store.sb, JOB, { sha256: shaA, bytes: BYTES_A }, store.read);
  assert(first.ok);
  assertEquals(first.url, `${STORAGE}/storage/v1/object/public/job-pdfs/sealed-quotes/${JOB}/${shaA}.pdf`);
  assertEquals(store.uploads, [{ path: `sealed-quotes/${JOB}/${shaA}.pdf`, upsert: false }]);
  assert(isSealedQuoteCopyPath(`sealed-quotes/${JOB}/${shaA}.pdf`));
  // A retry finds the same bytes already there: accepted.
  const again = await pinSealedQuotePdf(store.sb, JOB, { sha256: shaA, bytes: BYTES_A }, store.read);
  assert(again.ok && again.url === first.url);
  // Something else sits at the address: refused.
  const tampered = fakeStorage(new Map([[`sealed-quotes/${JOB}/${shaA}.pdf`, BYTES_B]]));
  assertEquals((await pinSealedQuotePdf(tampered.sb, JOB, { sha256: shaA, bytes: BYTES_A }, tampered.read)).ok, false);
  // An upload that fails and leaves nothing: refused.
  const broken = fakeStorage(new Map(), true);
  assertEquals((await pinSealedQuotePdf(broken.sb, JOB, { sha256: shaA, bytes: BYTES_A }, broken.read)).ok, false);
  // Bytes that do not hash to the claimed digest: refused before any write.
  const lie = fakeStorage(new Map());
  assertEquals((await pinSealedQuotePdf(lie.sb, JOB, { sha256: shaA, bytes: BYTES_B }, lie.read)).ok, false);
  assertEquals(lie.uploads, []);
});

Deno.test("linking a document to its copy only moves the address the guard checked", async () => {
  const calls: any[] = [];
  const sb = (rows: number, error: unknown = null) => ({
    from(table: string) {
      const call: any = { table, filters: [] as any[] };
      calls.push(call);
      const q: any = {
        update(patch: any) { call.patch = patch; return q; },
        in(col: string, v: unknown) { call.filters.push(["in", col, v]); return q; },
        eq(col: string, v: unknown) { call.filters.push(["eq", col, v]); return q; },
        select() { return Promise.resolve({ data: error ? null : Array.from({ length: rows }, () => ({})), error }); },
      };
      return q;
    },
  });
  assert(await linkDocumentsToSealedCopy(sb(1), ["d1"], "https://copy", PDF_A));
  assertEquals(calls[0].patch, { pdf_url: "https://copy" });
  assertEquals(calls[0].filters, [["in", "id", ["d1"]], ["eq", "pdf_url", PDF_A]]);
  assertEquals(await linkDocumentsToSealedCopy(sb(0), ["d1"], "https://copy", PDF_A), false, "the address moved since the check");
  assertEquals(await linkDocumentsToSealedCopy(sb(1), ["d1", "d2"], "https://copy"), false, "every row or none counts");
  assertEquals(await linkDocumentsToSealedCopy(sb(0, { code: "x" }), ["d1"], "https://copy"), false);
  assert(await linkDocumentsToSealedCopy(sb(0), [], "https://copy"));
});

// ── what is never judged ──

Deno.test("other job types and an already-refused source read nothing", async () => {
  for (const job_type of ["makesafe", "repair", "miscellaneous", null, undefined]) {
    const db = fakeDb({ flag: true });
    const g = await judgeSealedSend(db.sb, { path: "send", job_id: JOB, job_type, sealed: legacy, document: {} }, { storageBaseUrl: STORAGE });
    assertEquals(g, { kind: "not_judged" });
    assertEquals(db.reads, []);
  }
  const db = fakeDb({ flag: true });
  assertEquals(
    await judgeSealedSend(db.sb, { path: "send", job_id: JOB, job_type: "fencing", sealed: refused }, { storageBaseUrl: STORAGE }),
    { kind: "not_judged" },
  );
  assertEquals(db.reads, []);
});

Deno.test("the reason list matches the migration's CHECK", async () => {
  const sql = await Deno.readTextFile(
    new URL("../../../migrations/20261116114500_quote_send_sealed_revision_guard.sql", import.meta.url),
  );
  for (const r of SEALED_SEND_MISS_REASONS) assert(sql.includes(`'${r}'`), r);
  assert(sql.includes(`'${SEALED_REVISION_SEND_FLAG}', false`), "switch seeded off");
});

Deno.test("onOwnStorage reads only this project's public storage over https", () => {
  assert(onOwnStorage(PDF_A, STORAGE));
  assert(!onOwnStorage(PDF_A, undefined));
  assert(!onOwnStorage(PDF_A.replace("https:", "http:"), STORAGE));
  assert(!onOwnStorage(`${STORAGE}/storage/v1/object/sign/job-pdfs/a.pdf`, STORAGE));
  assert(!onOwnStorage("https://user:pw@project.supabase.example/storage/v1/object/public/a.pdf", STORAGE));
  assert(!onOwnStorage("not a url", STORAGE));
});

// ── at prepare ──

Deno.test("prepare records only a frozen revision of the same job", async () => {
  const revisions = {
    [REV]: { job_id: JOB, status: "frozen" },
    [OLDER]: { job_id: JOB, status: "superseded" },
    "66666666-6666-4666-8666-666666666666": { job_id: "77777777-7777-4777-8777-777777777777", status: "frozen" },
  };
  const db = fakeDb({ revisions });
  assertEquals(await quoteDocumentRevisionToRecord(db.sb, JOB, REV.toUpperCase()), { scope_revision_id: REV, reason: "recorded" });
  assertEquals((await quoteDocumentRevisionToRecord(db.sb, JOB, OLDER)).reason, "named_revision_not_frozen");
  assertEquals((await quoteDocumentRevisionToRecord(db.sb, JOB, "66666666-6666-4666-8666-666666666666")).reason, "named_revision_other_job");
  assertEquals((await quoteDocumentRevisionToRecord(db.sb, JOB, "88888888-8888-4888-8888-888888888888")).reason, "named_revision_missing");
  assertEquals((await quoteDocumentRevisionToRecord(db.sb, JOB, "nope")).reason, "named_id_malformed");
  assertEquals((await quoteDocumentRevisionToRecord(db.sb, JOB, undefined)).reason, "named_id_absent");
  assertEquals((await quoteDocumentRevisionToRecord(db.sb, JOB, null)).reason, "named_id_absent");
});

Deno.test("binding a document writes only its scope_revision_id", async () => {
  const db = fakeDb({});
  assert(await bindQuoteDocumentRevision(db.sb, "doc-1", REV));
  assert(await bindQuoteDocumentRevision(db.sb, "doc-2", null));
  assertEquals(db.updates, [
    { table: "job_documents", patch: { scope_revision_id: REV }, id: "doc-1" },
    { table: "job_documents", patch: { scope_revision_id: null }, id: "doc-2" },
  ]);
});

Deno.test("/send: the storage base decides; a valid quote passes with it, and an empty base fetches nothing and refuses", async () => {
  const input = {
    path: "send" as const, job_id: JOB, job_type: "fencing", sealed: sealed(),
    document: { scope_revision_id: REV, pdf_url: PDF_A },
  };
  fetches.length = 0;
  const ok = await judgeSealedSend(fakeDb(await goodWorld()).sb, input, { fetchImpl: fakeFetch, storageBaseUrl: STORAGE });
  assert(ok.kind === "pass" && ok.switch_on === true && ok.verified_pdf?.sha256 === await sha(BYTES_A));
  assertEquals(fetches.length, 1, "the one PDF is read once");
  fetches.length = 0;
  const empty = await judgeSealedSend(fakeDb(await goodWorld()).sb, input, { fetchImpl: fakeFetch, storageBaseUrl: "" });
  assert(empty.kind === "miss" && empty.reason === "document_pdf_not_from_revision");
  assertEquals(fetches, []);
});
