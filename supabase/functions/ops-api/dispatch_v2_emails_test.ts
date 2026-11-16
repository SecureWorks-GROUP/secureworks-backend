// deno-lint-ignore-file no-import-prefix no-explicit-any
// Dispatch v2 (docs/dispatch-v2-emails-contract.md): the supplier order email
// rules in dispatch_v2_emails.ts and the answer reader in dispatch_v2_send.ts.
// No database, and no email is sent: the one sender test uses a fake fetch.
// Job, client and supplier details here are made up.
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  cleanDispatchV2EmailList,
  DISPATCH_V2_ALSO_ATTACHED_TEXT,
  DISPATCH_V2_PHOTO_ONLY_TEXT,
  DISPATCH_V2_STANDING_LINES,
  dispatchV2AddressText,
  dispatchV2BodyHtml,
  dispatchV2BuildEmail,
  dispatchV2CanSuggest,
  dispatchV2CheckPhoto,
  dispatchV2ContactText,
  dispatchV2DefaultCc,
  dispatchV2DeliveryDateText,
  dispatchV2EmailHasSomethingToOrder,
  dispatchV2EmptyDetailLines,
  dispatchV2FulfilmentOf,
  dispatchV2FulfilmentParam,
  dispatchV2LineText,
  dispatchV2MainSupplierId,
  dispatchV2MentionsPickup,
  dispatchV2OrderableLines,
  dispatchV2PhotoFileName,
  dispatchV2SameLines,
  dispatchV2SuggestionAllowed,
  dispatchV2TeamCc,
  dispatchV2TestEmail,
  dispatchV2UnsentPhotoIds,
} from "./dispatch_v2_emails.ts";
import {
  outlookDispatchV2Sender,
  readDispatchV2SendAnswer,
} from "./dispatch_v2_send.ts";

const JOB = {
  job_number: "SWF-261600",
  client_name: "Jeremy Smith",
  client_phone: "0400 000 000",
  site_address: "12 Example Street",
  site_suburb: "Clarkson",
};

const PANELS = {
  id: "11111111-1111-4111-8111-111111111111",
  supplier_id: "s-stratco",
  description: "1800H standard width panels with 2400H posts",
  quantity: 14,
  unit: null,
  profile: "Neetascreen",
  colour: "Monument",
  position: 1,
  updated_at: "2026-10-23T01:00:00.000Z",
};
const PLINTHS = {
  id: "22222222-2222-4222-8222-222222222222",
  supplier_id: "s-stratco",
  description: "150mm standard width plinths",
  quantity: 14,
  unit: null,
  colour: "Monument",
  position: 2,
  updated_at: "2026-10-23T01:00:00.000Z",
};

Deno.test("email: a fencing main supplier email is the wiki template exactly, standing lines last", () => {
  const built = dispatchV2BuildEmail({
    job: JOB,
    workType: "fencing",
    isMainSupplier: true,
    lines: [PANELS, PLINTHS],
    deliveryDate: "2026-11-04",
  });
  assertEquals(built.subject, "Material Order Ref SWF-261600");
  assertEquals(
    built.body_text,
    [
      "Hi Team, could we please order the following for delivery:",
      "",
      "Date: 4 November 2026",
      "Address: 12 Example Street, Clarkson",
      "Contact: 0400 000 000 (Jeremy)",
      "",
      "Materials Needed:",
      "",
      "1. 14 x 1800H standard width panels with 2400H posts",
      "Profile: Neetascreen",
      "Colour: Monument",
      "",
      "2. 14 x 150mm standard width plinths",
      "Colour: Monument",
      "",
      "3. 4 x bags of quickset",
      "",
      "4. Fixings, Post Caps and Screws as necessary",
      "",
      "",
      "Please confirm when you can, thank you.",
    ].join("\n"),
  );
  assertEquals(built.standing_lines_included, true);
  assertEquals(built.missing, []);
  assertEquals(
    built.lines.map((l) => l.standing),
    [false, false, true, true],
  );
  // No job number in the body, no sign-off, no long dash.
  assert(!built.body_text.includes("SWF-261600"));
  assert(!/Kind regards|Regards|Thanks,/i.test(built.body_text));
  assert(!/[—–]/.test(built.body_text));
});

Deno.test("email: standing lines never go on a non-main fencing email, a patio or a repair email", () => {
  for (
    const [workType, isMain] of [
      ["fencing", false],
      ["patio", true],
      ["repair", true],
      ["decking", true],
    ] as const
  ) {
    const built = dispatchV2BuildEmail({
      job: JOB,
      workType,
      isMainSupplier: isMain,
      lines: [PLINTHS],
      deliveryDate: "2026-11-04",
    });
    assertEquals(built.standing_lines_included, false, workType);
    for (const line of DISPATCH_V2_STANDING_LINES) {
      assert(!built.body_text.includes(line), `${workType}: ${line}`);
    }
    assert(built.body_text.includes("1. 14 x 150mm standard width plinths"));
  }
});

Deno.test("email: an empty Date, Address or Contact is reported and found in the body", () => {
  const built = dispatchV2BuildEmail({
    job: { job_number: "SWF-1" },
    workType: "patio",
    isMainSupplier: false,
    lines: [PLINTHS],
    deliveryDate: null,
  });
  assertEquals(built.missing, ["date", "address", "contact"]);
  assertEquals(dispatchV2EmptyDetailLines(built.body_text), [
    "date",
    "address",
    "contact",
  ]);
  const filled = built.body_text.replace("Date:", "Date: 5 November 2026");
  assertEquals(dispatchV2EmptyDetailLines(filled), ["address", "contact"]);
});

Deno.test("pickup: the opening line says pickup and there is no Address line", () => {
  const built = dispatchV2BuildEmail({
    job: JOB,
    workType: "fencing",
    isMainSupplier: false,
    lines: [PLINTHS],
    deliveryDate: "2026-11-02",
    fulfilment: "pickup",
  });
  const lines = built.body_text.split("\n");
  assertEquals(
    lines[0],
    "Hi Team, could we please order the following for pickup:",
  );
  assert(!built.body_text.includes("Address:"));
  // Tweak 6: never the client's phone on a pickup. Shaun, 13 Nov 2026: the
  // client's first name sits on a Contact line straight under the Date.
  assert(!built.body_text.includes("0400 000 000"));
  assertEquals(lines.slice(2, 5), [
    "Date: 2 November 2026",
    "Contact: (Jeremy)",
    "",
  ]);
  assertEquals(built.missing, []);
  assertEquals(dispatchV2FulfilmentOf(built.body_text), "pickup");
  // A pickup with no site address and no client phone or name is not
  // missing anything but its date, and has no Contact line at all.
  const bare = dispatchV2BuildEmail({
    job: { job_number: "SWF-1" },
    workType: "patio",
    isMainSupplier: false,
    lines: [PLINTHS],
    deliveryDate: null,
    fulfilment: "pickup",
  });
  assertEquals(bare.missing, ["date"]);
  assert(!bare.body_text.includes("Contact:"));
  assertEquals(dispatchV2EmptyDetailLines(bare.body_text), ["date"]);
  // Delivery (and no choice at all) keeps the Address line.
  for (const fulfilment of ["delivery", null, undefined] as const) {
    const d = dispatchV2BuildEmail({
      job: JOB,
      workType: "fencing",
      isMainSupplier: false,
      lines: [PLINTHS],
      deliveryDate: "2026-11-02",
      fulfilment,
    });
    assert(d.body_text.startsWith(
      "Hi Team, could we please order the following for delivery:",
    ));
    assert(d.body_text.includes("Address: 12 Example Street, Clarkson"));
    assertEquals(dispatchV2FulfilmentOf(d.body_text), "delivery");
  }
});

Deno.test("pickup: read from the first non-empty line only", () => {
  for (const first of [
    "Hi Team, could we please order the following for pickup:",
    "Hi Team, could we please order the following for pick up:",
    "Hi Team, could we please order the following for Pick-up:",
    "Hi, we will collect this order:",
    "Ready for collection please",
  ]) {
    assertEquals(
      dispatchV2FulfilmentOf(`${first}\n\n1. 2 x posts`),
      "pickup",
      first,
    );
  }
  assertEquals(
    dispatchV2FulfilmentOf("\n  \r\nHi Team, for pickup:\n1. x"),
    "pickup",
  );
  // Pickup words further down do not count.
  assertEquals(
    dispatchV2FulfilmentOf(
      "Hi Team, could we please order the following for delivery:\n\nNo pickup",
    ),
    "delivery",
  );
  assertEquals(dispatchV2FulfilmentOf(""), "delivery");
  assertEquals(dispatchV2FulfilmentOf(null), "delivery");
  // Words that only look like it.
  assertEquals(
    dispatchV2FulfilmentOf("Please recollect the pickups"),
    "delivery",
  );
  assertEquals(
    dispatchV2MentionsPickup("You can collect on 02/11 before 12pm"),
    true,
  );
  assertEquals(dispatchV2MentionsPickup("Ready to pick up Monday"), true);
  assertEquals(dispatchV2MentionsPickup("We can deliver Tue 27 Oct"), false);
  assertEquals(dispatchV2MentionsPickup(null), false);
});

Deno.test("pickup: the make_email fulfilment value", () => {
  assertEquals(dispatchV2FulfilmentParam("pickup"), "pickup");
  assertEquals(dispatchV2FulfilmentParam("delivery"), "delivery");
  assertEquals(dispatchV2FulfilmentParam(undefined), null);
  assertEquals(dispatchV2FulfilmentParam(null), null);
  for (const bad of ["Pickup", "collect", "", 1, true, {}]) {
    assertEquals(dispatchV2FulfilmentParam(bad), undefined, String(bad));
  }
});

Deno.test("text: the date, address, contact and one line read as the template asks", () => {
  assertEquals(dispatchV2DeliveryDateText("2026-11-04"), "4 November 2026");
  assertEquals(dispatchV2DeliveryDateText("2026-02-30"), null);
  assertEquals(dispatchV2DeliveryDateText("4/11/2026"), null);
  assertEquals(
    dispatchV2AddressText({
      site_address: "13 Gazania St, Sinagra WA 6065, Australia",
      site_suburb: "Sinagra",
    }),
    "13 Gazania St, Sinagra WA 6065, Australia",
  );
  assertEquals(
    dispatchV2AddressText({ site_address: "12 Example Street", site_suburb: "Clarkson" }),
    "12 Example Street, Clarkson",
  );
  assertEquals(
    dispatchV2ContactText({ client_phone: "+61419905930", client_name: "Peter Example" }),
    "+61419905930 (Peter)",
  );
  assertEquals(
    dispatchV2LineText({
      description: "gate posts",
      quantity: 2,
      detail: "Gate: Pedestrian gate 1270mm",
      colour: "Dune",
    }),
    "2 x gate posts\nGate: Pedestrian gate 1270mm\nColour: Dune",
  );
  assertEquals(
    dispatchV2LineText({ description: "Lokklatch kit — black", quantity: null }),
    "Lokklatch kit, black",
  );
  assertEquals(
    dispatchV2LineText({ description: "sheets", quantity: 2.5, unit: "m" }),
    "2.5 m x sheets",
  );
});

Deno.test("team CC: fencing@, patios@, ses@ always on repairs; decking copies patios@ and is flagged open", () => {
  assertEquals(dispatchV2TeamCc("fencing"), {
    email: "fencing@secureworkswa.com.au",
    open_question: null,
  });
  assertEquals(dispatchV2TeamCc("patio").email, "patios@secureworkswa.com.au");
  assertEquals(dispatchV2TeamCc("repair").email, "ses@secureworkswa.com.au");
  const decking = dispatchV2TeamCc("decking");
  assertEquals(decking.email, "patios@secureworkswa.com.au");
  assert(decking.open_question);
  const other = dispatchV2TeamCc("miscellaneous");
  assertEquals(other.email, null);
  assert(other.open_question);
  assertEquals(
    dispatchV2DefaultCc(
      ["Tony.Bacich@stratcowa.com.au", "fencing@secureworkswa.com.au"],
      "fencing@secureworkswa.com.au",
      ["tradewa@stratcowa.com.au"],
    ),
    ["tony.bacich@stratcowa.com.au", "fencing@secureworkswa.com.au"],
  );
});

Deno.test("main supplier: the tick wins, else the box with the panels, else the first box", () => {
  const boxes = [
    { supplier_id: "a", position: 1 },
    { supplier_id: "b", position: 2 },
  ];
  assertEquals(dispatchV2MainSupplierId(boxes, []), "a");
  assertEquals(
    dispatchV2MainSupplierId(boxes, [{ supplier_id: "b", description: "Colorbond fence sheets, 1800mm high" }]),
    "b",
  );
  assertEquals(
    dispatchV2MainSupplierId(
      [{ supplier_id: "a", position: 1, is_main_supplier: true }, boxes[1]],
      [{ supplier_id: "b", description: "panels" }],
    ),
    "a",
  );
  assertEquals(dispatchV2MainSupplierId([], []), null);
});

Deno.test("lines: the email takes the box's lines that are not In stock, not sent and not on a PO, in order", () => {
  const d = "Posts";
  const lines = [
    { id: "3", supplier_id: "a", position: 3, status: "to_order", description: d },
    { id: "1", supplier_id: "a", position: 1, status: "not_reviewed", description: d },
    { id: "2", supplier_id: "a", position: 2, status: "in_stock", description: d },
    { id: "4", supplier_id: "a", position: 4, dispatch_order_email_id: "e", description: d },
    { id: "5", supplier_id: "b", position: 5, description: d },
    { id: "6", supplier_id: null, position: 6, description: d },
    // An empty row (no words) is not a line (Tweak 5).
    { id: "7", supplier_id: "a", position: 7, status: "to_order", description: "   " },
    { id: "8", supplier_id: "a", position: 8, status: "to_order" },
  ];
  assertEquals(dispatchV2OrderableLines(lines, "a").map((l) => l.id), ["1", "3"]);
  const snapshot = [
    { line_id: "1", updated_at: "2026-10-23T01:00:00Z" },
    { line_id: "3", updated_at: "2026-10-23T01:00:00.000Z" },
    { line_id: null, updated_at: null, standing: true },
  ];
  const current = [
    { id: "1", updated_at: "2026-10-23T01:00:00+00:00" },
    { id: "3", updated_at: "2026-10-23T01:00:00Z" },
  ];
  assert(dispatchV2SameLines(snapshot, current));
  assert(!dispatchV2SameLines(snapshot, [current[0]]));
  assert(
    !dispatchV2SameLines(snapshot, [current[0], { id: "3", updated_at: "2026-10-23T02:00:00Z" }]),
  );
});

Deno.test("suggestion: fencing and patio with no line; concrete, tek screws, removal and labour never suggested", () => {
  assert(dispatchV2CanSuggest("fencing", 0));
  assert(dispatchV2CanSuggest("patio", 0));
  assert(!dispatchV2CanSuggest("repair", 0));
  assert(!dispatchV2CanSuggest("fencing", 1));
  for (
    const bad of [
      "Concrete bags (20kg)",
      "Concrete footings (400x400x500mm)",
      "Tek screws (12-14 x 20)",
      "Old fence removal",
    ]
  ) {
    assert(!dispatchV2SuggestionAllowed(bad), bad);
  }
  for (const good of ["Colorbond fence sheets — 1800mm high", "Concrete plinths", "Fence posts (C-section)"]) {
    assert(dispatchV2SuggestionAllowed(good), good);
  }
});

Deno.test("addresses: a list is trimmed, lower-cased and de-duplicated; a bad address is refused, never dropped", () => {
  assertEquals(
    cleanDispatchV2EmailList([" A@Example.com ", "a@example.com", "b@example.com"], "cc", { min: 0, max: 5 }),
    { ok: true, value: ["a@example.com", "b@example.com"] },
  );
  assertEquals(cleanDispatchV2EmailList("a@example.com", "to", { min: 1, max: 5 }).ok, false);
  assertEquals(cleanDispatchV2EmailList(["not an email"], "to", { min: 1, max: 5 }).ok, false);
  assertEquals(cleanDispatchV2EmailList([], "to", { min: 1, max: 5 }).ok, false);
});

Deno.test("html: the body is escaped and keeps its line breaks; nothing else is added", () => {
  assertEquals(
    dispatchV2BodyHtml("Hi <Team> & co\n\n1. x"),
    '<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">Hi &lt;Team&gt; &amp; co<br><br>1. x</div>',
  );
});

Deno.test("test copy: clearly marked, says where the real email goes", () => {
  const marked = dispatchV2TestEmail({
    subject: "Material Order Ref SWF-261600",
    bodyText: "Hi Team",
    to: ["tradewa@stratcowa.com.au"],
    cc: ["fencing@secureworkswa.com.au"],
  });
  assertEquals(marked.subject, "TEST ONLY: Material Order Ref SWF-261600");
  assert(marked.body_text.startsWith("TEST ONLY."));
  assert(marked.body_text.includes("tradewa@stratcowa.com.au"));
  assert(marked.body_text.endsWith("Hi Team"));
  assert(!/[—–]/.test(marked.body_text));
});

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

Deno.test("photos: JPEG, PNG and WebP under 3,000,000 bytes; bigger is refused with its size; other kinds refused", () => {
  const jpeg = dispatchV2CheckPhoto(b64([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  assert(jpeg.ok && jpeg.contentType === "image/jpeg" && jpeg.extension === "jpg");
  const png = dispatchV2CheckPhoto(
    "data:image/png;base64," + b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  assert(png.ok && png.contentType === "image/png");
  const webp = dispatchV2CheckPhoto(
    b64([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP")]),
  );
  assert(webp.ok && webp.contentType === "image/webp");
  const pdf = dispatchV2CheckPhoto(b64([...new TextEncoder().encode("%PDF-1.4")]));
  assertEquals(pdf.ok, false);
  assertEquals((pdf as any).code, "photo_type_not_allowed");
  // 3,000,003 bytes of base64 'A' padding: refused on size before decoding.
  const big = dispatchV2CheckPhoto("A".repeat(4_000_004));
  assertEquals(big.ok, false);
  assertEquals((big as any).code, "photo_too_large");
  assert((big as any).error.includes("3.0 MB"));
  assertEquals(dispatchV2PhotoFileName("Nithin's list.HEIC", "jpg"), "Nithin-s-list.jpg");
  assertEquals(dispatchV2PhotoFileName("", "png"), "photo.png");
});

Deno.test("send answer: 202 with ids is sent; retry_safe or refused is not sent; unknown or 5xx is unknown", () => {
  assertEquals(
    readDispatchV2SendAnswer(202, {
      accepted: true,
      success: true,
      graph_message_id: "g1",
      internet_message_id: "<m1@x>",
      conversation_id: "c1",
    }),
    {
      kind: "sent",
      ids: { graph_message_id: "g1", internet_message_id: "<m1@x>", conversation_id: "c1" },
    },
  );
  assertEquals(readDispatchV2SendAnswer(400, { error: "bad", retry_safe: true }).kind, "refused");
  assertEquals(
    readDispatchV2SendAnswer(502, { error: "Graph API error", retry_safe: true, sent: false }).kind,
    "refused",
  );
  assertEquals(readDispatchV2SendAnswer(409, { state: "refused", code: "x" }).kind, "refused");
  const unknown = readDispatchV2SendAnswer(502, {
    state: "outcome_unknown",
    error: "timeout",
    retry_safe: false,
    conversation_id: "c2",
  });
  assertEquals(unknown.kind, "unknown");
  assertEquals((unknown as any).ids.conversation_id, "c2");
  assertEquals(readDispatchV2SendAnswer(504, null).kind, "unknown");
});

Deno.test("sender: posts to send-outlook-email with the key, no job_id; no answer is unknown", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const sender = outlookDispatchV2Sender({
    supabaseUrl: "https://stub.invalid",
    apiKey: "test-key",
    fetchImpl: (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return Response.json({
        accepted: true,
        success: true,
        graph_message_id: "g",
        internet_message_id: "<m@x>",
        conversation_id: "c",
      }, { status: 202 });
    }) as any,
  });
  const outcome = await sender({
    from: "admin@secureworkswa.com.au",
    to: ["tradewa@example.com"],
    cc: [],
    subject: "Material Order Ref SWF-1",
    htmlBody: "<div>x</div>",
    signature: "shaun",
    capture_thread_ids: true,
    attachments: [],
  });
  assertEquals(outcome.kind, "sent");
  assertEquals(seen[0].url, "https://stub.invalid/functions/v1/send-outlook-email");
  assertEquals((seen[0].init?.headers as any)["x-api-key"], "test-key");
  const sent = JSON.parse(String(seen[0].init?.body));
  assertEquals(sent.job_id, undefined);
  assertEquals(sent.capture_thread_ids, true);
  assertEquals(sent.signature, "shaun");

  const dead = outlookDispatchV2Sender({
    supabaseUrl: "https://stub.invalid",
    apiKey: "k",
    fetchImpl: (() => Promise.reject(new Error("connection reset"))) as any,
  });
  const lost = await dead({ ...JSON.parse(String(seen[0].init?.body)) });
  assertEquals(lost.kind, "unknown");
  const unset = outlookDispatchV2Sender({ supabaseUrl: "", apiKey: "" });
  assertEquals((await unset({} as any)).kind, "refused");
});

// ── Tweak 5: an order that is just a photo ──────────────────────────────────

Deno.test("photo only: no line and a photo says Please see attached, keeps the heading and the date format", () => {
  const built = dispatchV2BuildEmail({
    job: JOB,
    workType: "patio",
    isMainSupplier: true,
    lines: [],
    deliveryDate: "2026-11-10",
    fulfilment: "pickup",
    photoCount: 2,
  });
  assertEquals(built.photo_only, true);
  assertEquals(built.lines, []);
  assertEquals(
    built.body_text,
    [
      "Hi Team, could we please order the following for pickup:",
      "",
      "Date: 10 November 2026",
      "Contact: (Jeremy)",
      "",
      "Materials Needed:",
      "",
      "Please see attached for materials needed.",
      "",
      "",
      "Please confirm when you can, thank you.",
    ].join("\n"),
  );
  assertEquals(built.missing, []);
  assertEquals(DISPATCH_V2_PHOTO_ONLY_TEXT, "Please see attached for materials needed.");
  // No numbered line, and no long dash.
  assert(!/^\d+\. /m.test(built.body_text));
  assert(!/[\u2014\u2013]/.test(built.body_text));
});

Deno.test("photo only: a delivery keeps its Address and Contact lines", () => {
  const built = dispatchV2BuildEmail({
    job: JOB,
    workType: "patio",
    isMainSupplier: false,
    lines: [],
    deliveryDate: "2026-11-10",
    fulfilment: "delivery",
    photoCount: 1,
  });
  assertEquals(
    built.body_text,
    [
      "Hi Team, could we please order the following for delivery:",
      "",
      "Date: 10 November 2026",
      "Address: 12 Example Street, Clarkson",
      "Contact: 0400 000 000 (Jeremy)",
      "",
      "Materials Needed:",
      "",
      "Please see attached for materials needed.",
      "",
      "",
      "Please confirm when you can, thank you.",
    ].join("\n"),
  );
  assertEquals(built.photo_only, true);
});

Deno.test("photo only: the fencing standing lines are not added for the main supplier", () => {
  const built = dispatchV2BuildEmail({
    job: JOB,
    workType: "fencing",
    isMainSupplier: true,
    lines: [],
    deliveryDate: "2026-11-10",
    photoCount: 1,
  });
  assertEquals(built.photo_only, true);
  assertEquals(built.standing_lines_included, false);
  assertEquals(built.lines, []);
  for (const line of DISPATCH_V2_STANDING_LINES) {
    assert(!built.body_text.includes(line), line);
  }
  assert(built.body_text.includes(DISPATCH_V2_PHOTO_ONLY_TEXT));
});

Deno.test("photo only: an empty line row is ignored, so it is still photo only (never '1. ')", () => {
  const built = dispatchV2BuildEmail({
    job: JOB,
    workType: "patio",
    isMainSupplier: false,
    lines: [{ id: "x", description: "  ", quantity: null }],
    deliveryDate: "2026-11-10",
    photoCount: 1,
  });
  assertEquals(built.photo_only, true);
  assertEquals(built.lines, []);
  assert(!/^1\. /m.test(built.body_text));
});

Deno.test("photos and lines: numbered lines as before, then Please also see attached under them", () => {
  const built = dispatchV2BuildEmail({
    job: JOB,
    workType: "fencing",
    isMainSupplier: true,
    lines: [PLINTHS],
    deliveryDate: "2026-11-04",
    photoCount: 1,
  });
  assertEquals(built.photo_only, false);
  // The standing lines still go on when there are real lines.
  assertEquals(built.standing_lines_included, true);
  assert(built.body_text.endsWith(
    [
      "Materials Needed:",
      "",
      "1. 14 x 150mm standard width plinths",
      "Colour: Monument",
      "",
      "2. 4 x bags of quickset",
      "",
      "3. Fixings, Post Caps and Screws as necessary",
      "",
      "Please also see attached.",
      "",
      "",
      "Please confirm when you can, thank you.",
    ].join("\n"),
  ));
  assertEquals(DISPATCH_V2_ALSO_ATTACHED_TEXT, "Please also see attached.");
  // With no photo the email is exactly as before.
  const plain = dispatchV2BuildEmail({
    job: JOB,
    workType: "fencing",
    isMainSupplier: true,
    lines: [PLINTHS],
    deliveryDate: "2026-11-04",
  });
  assert(!plain.body_text.includes("attached"));
  assertEquals(plain.photo_only, false);
});

Deno.test("Tweak 6: a pickup has no Contact line; a delivery keeps it and still needs it", () => {
  const noPhone = { ...JOB, client_phone: null, client_name: null };
  const pickup = dispatchV2BuildEmail({
    job: noPhone,
    workType: "fencing",
    isMainSupplier: false,
    lines: [PLINTHS],
    deliveryDate: "2026-11-04",
    fulfilment: "pickup",
  });
  assert(!pickup.body_text.includes("Contact:"));
  assertEquals(pickup.missing, []);
  assertEquals(dispatchV2EmptyDetailLines(pickup.body_text), []);
  const delivery = dispatchV2BuildEmail({
    job: JOB,
    workType: "fencing",
    isMainSupplier: false,
    lines: [PLINTHS],
    deliveryDate: "2026-11-04",
    fulfilment: "delivery",
  });
  assert(delivery.body_text.includes("\nContact: 0400 000 000 (Jeremy)\n"));
  const deliveryNoPhone = dispatchV2BuildEmail({
    job: noPhone,
    workType: "fencing",
    isMainSupplier: false,
    lines: [PLINTHS],
    deliveryDate: "2026-11-04",
    fulfilment: "delivery",
  });
  assertEquals(deliveryNoPhone.missing, ["contact"]);
  assertEquals(dispatchV2EmptyDetailLines(deliveryNoPhone.body_text), ["contact"]);
});

Deno.test("send check: an email needs a line or a photo", () => {
  assert(dispatchV2EmailHasSomethingToOrder({ order_lines: [{ line_id: "1" }], photo_ids: [] }));
  assert(dispatchV2EmailHasSomethingToOrder({ order_lines: [], photo_ids: ["p"] }));
  assert(!dispatchV2EmailHasSomethingToOrder({ order_lines: [], photo_ids: [] }));
  assert(!dispatchV2EmailHasSomethingToOrder({}));
});

Deno.test("photos for a new email: oldest first, at most three, leaving out photos already sent", () => {
  const photo = (id: string, at: string) => ({ id, created_at: at });
  const photos = [
    photo("p3", "2026-11-05T03:00:00Z"),
    photo("p1", "2026-11-05T01:00:00Z"),
    photo("p2", "2026-11-05T02:00:00Z"),
    photo("p4", "2026-11-05T04:00:00Z"),
    photo("p5", "2026-11-05T05:00:00Z"),
  ];
  assertEquals(dispatchV2UnsentPhotoIds(photos, []), ["p1", "p2", "p3"]);
  const emails = [
    { status: "sent", photo_ids: ["p1"] },
    { status: "send_unknown", photo_ids: ["p2"] },
    // A held or thrown-away email has not sent its photos.
    { status: "draft", photo_ids: ["p3"] },
    { status: "discarded", photo_ids: ["p4"] },
  ];
  assertEquals(dispatchV2UnsentPhotoIds(photos, emails), ["p3", "p4", "p5"]);
  assertEquals(
    dispatchV2UnsentPhotoIds(photos, [{ status: "sent", photo_ids: ["p1", "p2", "p3", "p4", "p5"] }]),
    [],
  );
});
