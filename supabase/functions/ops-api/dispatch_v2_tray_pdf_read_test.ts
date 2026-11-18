// deno-lint-ignore-file no-explicit-any
// Dispatch v2 item 16b: the tray reads its PDFs and suggests a job.
// Contract: docs/dispatch-v2-board-contract.md section 3j.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  addTrayPdfReads,
  clientNameParts,
  isReadableTrayFile,
  mergeCandidates,
  normaliseForMatch,
  rankJobsFromWords,
  requestTrayPdfReads,
  signsInWords,
  streetInText,
  streetKeyOf,
  stripReaderHeader,
  summaryLine,
  summaryState,
  TRAY_PDF_REQUESTS_PER_RUN,
  type TrayPdfReadRow,
  type TrayPdfStore,
} from "./dispatch_v2_tray_pdf_read.ts";
import type { JobHint } from "./dispatch_v2_replies_rules.ts";

const ORG = "00000000-0000-0000-0000-000000000001";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// The four Ampelite jobs of 16 Nov 2026, as their job records hold them.
const ROSE: JobHint = {
  job_id: id(1),
  job_number: "SWP-26100",
  client_name: "Rose",
  site_address: "13 Woodall Ct, High Wycombe WA 6057, Australia",
  site_suburb: "High Wycombe",
  status: "scheduled",
  type: "patio",
};
const ANGUS: JobHint = {
  job_id: id(2),
  job_number: "SWP-261178",
  client_name: "Angus Roxburgh",
  site_address: "1 Drift La, Aveley WA 6069, Australia",
  site_suburb: "1 Drift Lane Aveley",
  status: "scheduled",
  type: "patio",
};
const RINA: JobHint = {
  job_id: id(3),
  job_number: "SWP-261336",
  client_name: "Rina",
  site_address: "6 Moorby Pl, Balcatta WA 6021, Australia",
  site_suburb: "Balcatta",
  status: "in_progress",
  type: "patio",
};
const MILAN: JobHint = {
  job_id: id(4),
  job_number: "SWP-26595",
  client_name: "Milan Mall",
  site_address: "15 McMahon Way, Kardinya WA 6163, Australia",
  site_suburb: "Kardinya",
  status: "in_progress",
  type: "patio",
};
const CANCELLED_AT_WOODALL: JobHint = {
  ...ROSE,
  job_id: id(5),
  job_number: "SWP-25001",
  status: "cancelled",
};
const JOBS = [ROSE, ANGUS, RINA, MILAN];

// A scanned delivery docket as the picture reader writes it back.
const docket = (lines: string[]) =>
  `[Document text: Email attachment "16112026123808-0001.pdf", 1 page. Words read from a picture of it, not a message.]\n\n` +
  [
    "AMPELITE AUSTRALIA",
    "DELIVERY DOCKET",
    "Customer: SECUREWORKS WA PTY LTD",
    "Unit 2 20 Uppill Pl WANGARA WA 6065",
    ...lines,
    "SUNTUF 10.5 CLEAR 4.2M 12",
  ].join("\n");

const noSigns = () => ({ jobNumbers: new Set<string>(), refsByJob: new Map() });

// ── Words ───────────────────────────────────────────────────────────────────

Deno.test("16b: the reader's own header line is never matched", () => {
  const w = stripReaderHeader(
    '[Document text: Email attachment "SWP-26100.pdf", 1 page. Words read from the PDF text layer, not a message.]\n\nHello',
  );
  assertEquals(w, "Hello");
  // The job number in the file NAME is not a job number printed on it.
  assertEquals(
    signsInWords(
      '[Document text: Email attachment "SWP-26100.pdf", 1 page.]\n\nNo refs here',
    ).job_numbers,
    [],
  );
});

Deno.test("16b: street keys from job addresses", () => {
  assertEquals(streetKeyOf(ROSE.site_address, ROSE.site_suburb), {
    number: "13",
    street: ["WOODALL"],
    printed: "13 Woodall Ct",
  });
  assertEquals(streetKeyOf("Unit 2/15 Smith Street", null)?.number, "15");
  assertEquals(streetKeyOf("Unit 2/15 Smith Street", null)?.street, ["SMITH"]);
  assertEquals(streetKeyOf("45B Clover St Dianella WA 6059", "Dianella"), {
    number: "45B",
    street: ["CLOVER"],
    printed: "45B Clover St",
  });
  assertEquals(streetKeyOf("15 McMahon Way", null)?.street, ["MCMAHON"]);
  assertEquals(streetKeyOf("Lot 5 Great Eastern Hwy", null), null); // no house number
  assertEquals(streetKeyOf("", null), null);
  assertEquals(streetKeyOf("12 St", null), null); // a type, not a name
  assertEquals(streetKeyOf("3 Ox Rd", null), null); // name too short to be safe
});

Deno.test("16b: a street is found with or without its type, never inside another number", () => {
  const key = streetKeyOf(ROSE.site_address, null)!;
  assert(
    streetInText(
      key,
      normaliseForMatch("DELIVER TO: 13 WOODALL COURT HIGH WYCOMBE"),
    ),
  );
  assert(streetInText(key, normaliseForMatch("13 Woodall Ct")));
  assert(streetInText(key, normaliseForMatch("Unit 4/13 Woodall Crt")));
  assert(!streetInText(key, normaliseForMatch("113 Woodall Ct")));
  assert(!streetInText(key, normaliseForMatch("13 Woodallen Rd")));
  assert(!streetInText(key, normaliseForMatch("Woodall Ct 13")));
});

Deno.test("16b: client names need a first and a last name", () => {
  assertEquals(clientNameParts("Angus Roxburgh"), {
    first: "ANGUS",
    last: "ROXBURGH",
  });
  assertEquals(clientNameParts("Rose"), null);
  assertEquals(clientNameParts("Mr John van der Berg"), {
    first: "JOHN",
    last: "BERG",
  });
  assertEquals(clientNameParts(null), null);
});

Deno.test("16b: signs in the words: our job numbers and learnable supplier numbers", () => {
  const s = signsInWords(
    docket(["Your Ref SWP26595", "Order No: 4412873", "Account 7781"]),
  );
  assertEquals(s.job_numbers, ["SWP-26595"]);
  assertEquals(s.supplier_refs, ["4412873"]);
});

// ── Ranking ─────────────────────────────────────────────────────────────────

Deno.test("16b: the four Ampelite dockets each put their own job first", () => {
  const cases: [string[], JobHint, string][] = [
    [
      ["DELIVER TO: 13 WOODALL CT", "HIGH WYCOMBE WA 6057", "Ref: ROSE"],
      ROSE,
      "13 Woodall Ct, High Wycombe",
    ],
    [
      ["Site: 1 Drift Lane, Aveley", "Contact: Angus Roxburgh 0400 000 000"],
      ANGUS,
      "1 Drift La, Angus Roxburgh",
    ],
    [
      ["DELIVERY ADDRESS 6 MOORBY PLACE BALCATTA"],
      RINA,
      "6 Moorby Pl, Balcatta",
    ],
    [
      ["Cust Ref: SWP-26595", "15 McMahon Way Kardinya"],
      MILAN,
      "15 McMahon Way, Kardinya, Ref SWP-26595",
    ],
  ];
  for (const [lines, job, evidence] of cases) {
    const words = docket(lines);
    const s = signsInWords(words);
    const ranked = rankJobsFromWords(words, JOBS, {
      jobNumbers: new Set(s.job_numbers),
      refsByJob: new Map(),
    });
    assertEquals(ranked[0]?.job.job_number, job.job_number, lines.join(" / "));
    assertEquals(ranked[0].evidence.join(", "), evidence);
    assertEquals(ranked.length, 1, "no other job reaches the bar");
  }
});

Deno.test("16b: a printed job number beats an address on another job", () => {
  const words = docket(["Ref SWP-261336", "13 Woodall Ct High Wycombe"]);
  const ranked = rankJobsFromWords(words, JOBS, {
    jobNumbers: new Set(signsInWords(words).job_numbers),
    refsByJob: new Map(),
  });
  assertEquals(ranked.map((r) => r.job.job_number), [
    "SWP-261336",
    "SWP-26100",
  ]);
  assertEquals(ranked[0].score, 100);
  assertEquals(ranked[1].score, 70);
});

Deno.test("16b: a learned supplier number points at its one job", () => {
  const words = docket(["Order No: 4412873"]);
  const ranked = rankJobsFromWords(words, JOBS, {
    jobNumbers: new Set(),
    refsByJob: new Map([[MILAN.job_id, ["4412873"]]]),
  });
  assertEquals(ranked.map((r) => r.job.job_number), ["SWP-26595"]);
  assertEquals(ranked[0].evidence, ["Order 4412873"]);
});

Deno.test("16b: nothing we know on the page suggests nothing", () => {
  const words = docket(["DELIVER TO 99 Nowhere Rd Perth", "Contact Rose"]);
  assertEquals(rankJobsFromWords(words, JOBS, noSigns()), []);
  // Our own office address (on every docket) is never a client's site.
  assertEquals(rankJobsFromWords(docket([]), JOBS, noSigns()), []);
});

Deno.test("16b: a surname alone is not enough; beside an address it adds", () => {
  const surnameOnly = docket(["Attn: Roxburgh"]);
  assertEquals(rankJobsFromWords(surnameOnly, JOBS, noSigns()), []);
  const withAddress = docket(["1 Drift La", "Attn: Roxburgh"]);
  const r = rankJobsFromWords(withAddress, JOBS, noSigns());
  assertEquals(r[0].job.job_number, "SWP-261178");
  assertEquals(r[0].score, 70);
  assertEquals(r[0].evidence, ["1 Drift La", "Roxburgh"]);
});

Deno.test("16b: a closed job is never suggested from an address, only from its printed number", () => {
  const words = docket(["13 Woodall Ct"]);
  const byAddress = rankJobsFromWords(words, [CANCELLED_AT_WOODALL], noSigns());
  assertEquals(byAddress, []);
  const byNumber = rankJobsFromWords(docket(["Ref SWP-25001"]), [
    CANCELLED_AT_WOODALL,
  ], {
    jobNumbers: new Set(["SWP-25001"]),
    refsByJob: new Map(),
  });
  assertEquals(byNumber[0].job.job_number, "SWP-25001");
});

Deno.test("16b: two jobs at one address: the one with the sender's open order, then the one going ahead", () => {
  // Rose has two scheduled jobs at 13 Woodall Ct (SWP-26100 and SWP-26992).
  const second: JobHint = { ...ROSE, job_id: id(6), job_number: "SWP-26992" };
  const quote: JobHint = {
    ...ROSE,
    job_id: id(7),
    job_number: "SWP-25000",
    status: "quoted",
  };
  const words = docket(["13 Woodall Ct"]);
  assertEquals(
    rankJobsFromWords(words, [quote, second, ROSE], noSigns()).map((r) =>
      r.job.job_number
    ),
    ["SWP-26100", "SWP-26992", "SWP-25000"],
  );
  assertEquals(
    rankJobsFromWords(words, [quote, second, ROSE], noSigns(), new Set([id(6)]))
      .map((r) => r.job.job_number),
    ["SWP-26992", "SWP-26100", "SWP-25000"],
  );
});

Deno.test("16b: at most three jobs come from the PDF", () => {
  const many = Array.from({ length: 5 }, (_, i) => ({
    ...ROSE,
    job_id: id(100 + i),
    job_number: `SWP-2610${i}`,
  }));
  const r = rankJobsFromWords(docket(["13 Woodall Ct"]), many, noSigns());
  assertEquals(r.length, 3);
});

// ── Card state and line ─────────────────────────────────────────────────────

const read = (
  state: TrayPdfReadRow["read_state"],
  words: string | null = null,
): TrayPdfReadRow => ({
  attachment_id: id(900),
  read_state: state,
  method: state === "read" ? "picture" : null,
  words,
  read_at: null,
});

Deno.test("16b: the card state from its files", () => {
  assertEquals(summaryState([]), "none");
  assertEquals(summaryState([read("cannot_read"), read("read", "x")]), "read");
  assertEquals(summaryState([read("cannot_read"), read("waiting")]), "reading");
  assertEquals(summaryState([read("not_read")]), "reading");
  assertEquals(
    summaryState([read("no_words"), read("cannot_read")]),
    "no_words",
  );
  assertEquals(summaryState([read("cannot_read")]), "cannot_read");
});

Deno.test("16b: the card line", () => {
  assertEquals(
    summaryLine("read", { evidence: ["12 Smith St", "Ref SWP-26595"] }),
    "Read from the PDF: 12 Smith St, Ref SWP-26595",
  );
  assertEquals(
    summaryLine("read", null),
    "Read from the PDF: no job number, address or client name we know",
  );
  assert(summaryLine("reading", null)!.startsWith("Reading the PDF"));
  assertEquals(summaryLine("none", null), null);
});

Deno.test("16b: only kept PDFs and pictures within 5 MB are read", () => {
  const f = (o: any) => ({
    id: id(1),
    openable: true,
    kind_label: "PDF",
    content_type: "application/pdf",
    file_name: "a.pdf",
    size_bytes: 1000,
    ...o,
  });
  assert(isReadableTrayFile(f({})));
  assert(
    isReadableTrayFile(
      f({
        kind_label: "Image",
        content_type: "image/jpeg",
        file_name: "a.jpg",
      }),
    ),
  );
  assert(!isReadableTrayFile(f({ openable: false })));
  assert(!isReadableTrayFile(f({ size_bytes: 6_000_000 })));
  assert(
    !isReadableTrayFile(
      f({
        kind_label: "Word",
        content_type: "application/msword",
        file_name: "a.docx",
      }),
    ),
  );
  assert(!isReadableTrayFile(f({ id: "not-a-uuid" })));
});

Deno.test("16b: Could be puts the PDF's jobs first and keeps the tray's order on the same job", () => {
  const merged = mergeCandidates(
    [{
      order_id: null,
      job_id: id(4),
      job_number: "SWP-26595",
      supplier_name: "Ampelite",
      reason: "Read from the PDF: Ref SWP-26595",
      from_pdf: true,
      score: 100,
    }],
    [
      {
        order_id: id(77),
        job_id: id(4),
        job_number: "SWP-26595",
        supplier_name: "Ampelite",
        reason: "Open order",
      },
      {
        order_id: id(78),
        job_id: id(1),
        job_number: "SWP-26100",
        supplier_name: "Ampelite",
        reason: "Open order",
      },
    ],
  );
  assertEquals(merged.map((c) => c.job_number), ["SWP-26595", "SWP-26100"]);
  assertEquals(merged[0].order_id, id(77));
  assertEquals((merged[0] as any).from_pdf, true);
  assertEquals(merged[0].reason, "Read from the PDF: Ref SWP-26595");
});

// ── The tray read, end to end with a fake store ─────────────────────────────

function fakeStore(reads: TrayPdfReadRow[], over: Partial<TrayPdfStore> = {}) {
  const calls = {
    pdfReads: [] as string[][],
    liveJobs: 0,
    requestReads: [] as number[],
  };
  const store: TrayPdfStore = {
    pdfReads: (ids) => {
      calls.pdfReads.push(ids);
      return Promise.resolve(
        reads.filter((r) => ids.includes(r.attachment_id)),
      );
    },
    jobsByNumbers: (_o, numbers) =>
      Promise.resolve(
        [...JOBS, CANCELLED_AT_WOODALL].filter((j) =>
          numbers.includes(j.job_number!)
        ),
      ),
    liveJobs: () => {
      calls.liveJobs++;
      return Promise.resolve(JOBS);
    },
    refLinks: () => Promise.resolve([]),
    requestReads: (n) => {
      calls.requestReads.push(n);
      return Promise.resolve(2);
    },
    ...over,
  };
  return { store, calls };
}

const file = (n: number, o: any = {}) => ({
  id: id(n),
  file_name: `scan-${n}.pdf`,
  content_type: "application/pdf",
  size_bytes: 190000,
  kind_label: "PDF",
  openable: true,
  ...o,
});

Deno.test("16b: the tray read adds pdf_read and puts the PDF's job first", async () => {
  const { store, calls } = fakeStore([
    {
      attachment_id: id(10),
      read_state: "read",
      method: "picture",
      words: docket(["Ref: SWP-26595", "15 McMahon Way Kardinya"]),
      read_at: null,
    },
    {
      attachment_id: id(20),
      read_state: "waiting",
      method: null,
      words: null,
      read_at: null,
    },
  ]);
  const answer = {
    ok: true,
    emails: [
      {
        id: "e1",
        supplier_name: "Ampelite",
        attachments: [file(10)],
        candidates: [{
          order_id: null,
          job_id: id(1),
          job_number: "SWP-26100",
          supplier_name: "Ampelite",
          reason: "Open order",
        }],
      },
      {
        id: "e2",
        supplier_name: "Ampelite",
        attachments: [file(20)],
        candidates: [],
      },
      {
        id: "e3",
        supplier_name: "Stratco",
        attachments: [
          file(30, {
            kind_label: "Word",
            content_type: "application/msword",
            file_name: "a.docx",
          }),
        ],
        candidates: [],
      },
      { id: "e4", supplier_name: "Stratco", attachments: null, candidates: [] },
    ],
  };
  const out: any = await addTrayPdfReads(store, ORG, answer);
  assertEquals(out.pdf_reads_read, "ok");
  assertEquals(calls.pdfReads, [[id(10), id(20)]]);
  assertEquals(calls.liveJobs, 1);
  const [e1, e2, e3, e4] = out.emails;
  assertEquals(e1.pdf_read.state, "read");
  assertEquals(
    e1.pdf_read.line,
    "Read from the PDF: 15 McMahon Way, Kardinya, Ref SWP-26595",
  );
  assertEquals(e1.pdf_read.found.job_numbers, ["SWP-26595"]);
  assertEquals(e1.candidates.map((c: any) => c.job_number), [
    "SWP-26595",
    "SWP-26100",
  ]);
  assertEquals(e1.candidates[0].from_pdf, true);
  // A suggestion only: the email's own match fields are untouched.
  assertEquals(e1.job_id, undefined);
  assertEquals(e1.state, undefined);
  assertEquals(e2.pdf_read.state, "reading");
  assertEquals(e2.candidates, []);
  assertEquals(e3.pdf_read.state, "none");
  assertEquals(e3.pdf_read.line, null);
  assertEquals(e4.pdf_read.state, "none");
});

Deno.test("16b: no words anywhere means no job list is read", async () => {
  const { store, calls } = fakeStore([
    {
      attachment_id: id(20),
      read_state: "waiting",
      method: null,
      words: null,
      read_at: null,
    },
  ]);
  const out: any = await addTrayPdfReads(store, ORG, {
    emails: [{ id: "e2", attachments: [file(20)], candidates: [] }],
  });
  assertEquals(calls.liveJobs, 0);
  assertEquals(out.emails[0].pdf_read.state, "reading");
});

Deno.test("16b: a supplier number seen on two jobs is not used", async () => {
  const { store } = fakeStore(
    [{
      attachment_id: id(10),
      read_state: "read",
      method: "text",
      words: docket(["Order No: 4412873"]),
      read_at: null,
    }],
    {
      refLinks: () =>
        Promise.resolve([{ ref: "4412873", job_id: id(1) }, {
          ref: "4412873",
          job_id: id(4),
        }]),
    },
  );
  const out: any = await addTrayPdfReads(store, ORG, {
    emails: [{ id: "e1", attachments: [file(10)], candidates: [] }],
  });
  assertEquals(out.emails[0].candidates, []);
  assertEquals(
    out.emails[0].pdf_read.line,
    "Read from the PDF: no job number, address or client name we know",
  );
});

Deno.test("16b: a failed read leaves the tray as it was", async () => {
  const { store } = fakeStore([], {
    pdfReads: () => Promise.reject(new Error("boom")),
  });
  const emails = [{
    id: "e1",
    attachments: [file(10)],
    candidates: [{ job_id: id(1) }],
  }];
  const out: any = await addTrayPdfReads(store, ORG, { emails });
  assertEquals(out.pdf_reads_read, "failed");
  assertEquals(out.emails[0].pdf_read, null);
  assertEquals(out.emails[0].candidates, [{ job_id: id(1) }]);
});

Deno.test("16b: an empty tray reads nothing", async () => {
  const { store, calls } = fakeStore([]);
  const out: any = await addTrayPdfReads(store, ORG, { ok: true, emails: [] });
  assertEquals(out.pdf_reads_read, "ok");
  assertEquals(calls.pdfReads.length, 0);
});

// ── The scan asks for the reads ─────────────────────────────────────────────

Deno.test("16b: the scan asks for at most 4 reads and never throws", async () => {
  const { store, calls } = fakeStore([]);
  assertEquals(await requestTrayPdfReads(store), { ok: true, requested: 2 });
  assertEquals(calls.requestReads, [TRAY_PDF_REQUESTS_PER_RUN]);
  assertEquals(TRAY_PDF_REQUESTS_PER_RUN, 4);
  assertEquals(
    await requestTrayPdfReads({
      requestReads: () => Promise.reject(new Error("down")),
    }),
    { ok: false, requested: 0 },
  );
});
