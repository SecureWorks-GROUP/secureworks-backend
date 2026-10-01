// deno-lint-ignore-file no-import-prefix
import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEBT_DRAFT_STEPS,
  debtDraftId,
  type DebtDraftInput,
  debtDraftText,
  debtDraftTextProblem,
  greetingName,
  parseDebtDraftId,
} from "./debt_draft_templates.ts";

const one: DebtDraftInput = {
  step: "friendly_text",
  payer_name: "Sam Example",
  invoices: [{
    xero_invoice_id: "aaaaaaaa-0000-4000-8000-000000000001",
    invoice_number: "INV-1578",
    amount_due: 4200,
    due_date: "2026-09-29",
    days_overdue: 2,
  }],
};

const two: DebtDraftInput = {
  ...one,
  invoices: [
    one.invoices[0],
    {
      xero_invoice_id: "aaaaaaaa-0000-4000-8000-000000000002",
      invoice_number: "INV-1601",
      amount_due: 150.5,
      due_date: "2026-09-27",
      days_overdue: 4,
    },
  ],
};

Deno.test("drafts: the four steps the desk drafts", () => {
  assertEquals(DEBT_DRAFT_STEPS, [
    "friendly_text",
    "firm_text",
    "jan_visit",
    "deposit_reminder",
  ]);
});

Deno.test("friendly text: name, invoice number, amount and due date, nothing else", () => {
  assertEquals(
    debtDraftText(one),
    "Hi Sam, a friendly reminder that invoice INV-1578 for $4,200.00 was due on 29 Sep 2026. " +
      "If you have already paid, thank you, and please ignore this message. Thanks, SecureWorks",
  );
  assertEquals(
    debtDraftText(two),
    "Hi Sam, a friendly reminder that invoices INV-1578 ($4,200.00, due 29 Sep 2026) and " +
      "INV-1601 ($150.50, due 27 Sep 2026), $4,350.50 in total, are now due. " +
      "If you have already paid, thank you, and please ignore this message. Thanks, SecureWorks",
  );
});

Deno.test("firm text: carries each invoice's own Xero pay link, and refuses without one", () => {
  const links = {
    "aaaaaaaa-0000-4000-8000-000000000001": "https://in.xero.com/AAA",
    "aaaaaaaa-0000-4000-8000-000000000002": "https://in.xero.com/BBB",
  };
  assertEquals(
    debtDraftText({ ...one, step: "firm_text", pay_links: links }),
    "Hi Sam, invoice INV-1578 for $4,200.00 was due on 29 Sep 2026 and is still unpaid. " +
      "Please pay it today here: https://in.xero.com/AAA " +
      "If you have already paid, please reply to let us know. Thanks, SecureWorks",
  );
  assertEquals(
    debtDraftText({ ...two, step: "firm_text", pay_links: links }),
    "Hi Sam, invoices INV-1578 ($4,200.00, due 29 Sep 2026) and INV-1601 ($150.50, due 27 Sep 2026), " +
      "$4,350.50 in total, are still unpaid. Please pay them today here: " +
      "INV-1578 https://in.xero.com/AAA and INV-1601 https://in.xero.com/BBB " +
      "If you have already paid, please reply to let us know. Thanks, SecureWorks",
  );
  assertThrows(
    () =>
      debtDraftText({
        ...two,
        step: "firm_text",
        pay_links: {
          [one.invoices[0].xero_invoice_id]: "https://in.xero.com/AAA",
        },
      }),
    Error,
    "INV-1601",
  );
});

Deno.test("Jan's text goes to Jan: who, what, where, and the client's phone when known", () => {
  assertEquals(
    debtDraftText({
      ...one,
      step: "jan_visit",
      site: "12 Example Street, Exampleton",
      phone: "0400 000 000",
    }),
    "Hi Jan, please visit Sam Example about unpaid invoice INV-1578, $4,200.00, due 29 Sep 2026 (2 days overdue). " +
      "Site: 12 Example Street, Exampleton. Phone: 0400 000 000. Please tell Shaun how it goes.",
  );
  assertEquals(
    debtDraftText({ ...two, step: "jan_visit" }),
    "Hi Jan, please visit Sam Example about unpaid invoices INV-1578 ($4,200.00, due 29 Sep 2026) and " +
      "INV-1601 ($150.50, due 27 Sep 2026), $4,350.50 in total. Please tell Shaun how it goes.",
  );
});

Deno.test("deposit reminder: one friendly reminder about the job", () => {
  const deposit = {
    ...one,
    step: "deposit_reminder" as const,
    invoices: [{ ...one.invoices[0], kind: "deposit" }],
  };
  assertEquals(
    debtDraftText(deposit),
    "Hi Sam, a friendly reminder about the deposit for your job: invoice INV-1578 for $4,200.00 was due on 29 Sep 2026. " +
      "If you have already paid, thank you, and please ignore this message. " +
      "If you have any questions about the job, just reply to this text. Thanks, SecureWorks",
  );
});

Deno.test("deposit reminder: a progress claim, a materials invoice or an unknown kind is never called a deposit", () => {
  for (const kind of ["progress_claim", "materials", null, undefined]) {
    const text = debtDraftText({
      ...one,
      step: "deposit_reminder",
      invoices: [{ ...one.invoices[0], kind }],
    });
    assert(!/deposit/i.test(text), `${kind}: ${text}`);
    assert(
      text.startsWith(
        "Hi Sam, a friendly reminder about the invoice for your job: invoice INV-1578",
      ),
      text,
    );
  }
  const mixed = debtDraftText({
    ...two,
    step: "deposit_reminder",
    invoices: [
      { ...two.invoices[0], kind: "deposit" },
      { ...two.invoices[1], kind: "materials" },
    ],
  });
  assert(!/deposit/i.test(mixed), mixed);
  assert(mixed.includes("about the invoices for your job: invoices INV-1578"));
});

Deno.test("no draft threatens, invents or mentions legal action or credit reporting", () => {
  const links = {
    "aaaaaaaa-0000-4000-8000-000000000001": "https://in.xero.com/AAA",
    "aaaaaaaa-0000-4000-8000-000000000002": "https://in.xero.com/BBB",
  };
  for (const step of DEBT_DRAFT_STEPS) {
    for (const input of [one, two]) {
      const text = debtDraftText({ ...input, step, pay_links: links });
      assertEquals(debtDraftTextProblem(text), null, `${step}: ${text}`);
      assert(!/—/.test(text));
    }
  }
});

Deno.test("the text check refuses em dashes, threats, legal and credit-reporting talk", () => {
  assertEquals(debtDraftTextProblem("  "), "The message is empty");
  assert(debtDraftTextProblem("Pay now — thanks")?.includes("em dash"));
  for (
    const bad of [
      "We will take legal action",
      "This goes to our lawyer next week",
      "We will refer this to a debt collector",
      "This may affect your credit rating",
      "We will report it to the credit bureau",
      "Final notice before court",
      "letter of demand follows",
      "We will list a default",
    ]
  ) {
    assert(debtDraftTextProblem(bad)?.startsWith("The message mentions"), bad);
  }
  assert(debtDraftTextProblem("x".repeat(1001))?.includes("1000"));
});

Deno.test("greeting: a person's first name, else the whole name", () => {
  assertEquals(greetingName("Sam Example"), "Sam");
  assertEquals(greetingName("  sam  "), "sam");
  assertEquals(greetingName("Mr & Mrs Example"), "Mr & Mrs Example");
  assertEquals(greetingName("Mrs Example"), "Mrs Example");
  assertEquals(
    greetingName("Example Holdings Pty Ltd"),
    "Example Holdings Pty Ltd",
  );
  assertEquals(greetingName("Sam and Alex Example"), "Sam and Alex Example");
  assertEquals(greetingName(""), "there");
});

Deno.test("draft id: the item id plus each invoice's amount in cents, read back exactly", () => {
  const itemId = "2026-10-01:contact-a:text:friendly_text";
  const id = debtDraftId(itemId, two.invoices);
  assertEquals(id, "2026-10-01:contact-a:text:friendly_text|420000,15050");
  assertEquals(parseDebtDraftId(id), {
    item_id: itemId,
    perth_date: "2026-10-01",
    group: "text",
    step: "friendly_text",
    amounts: [4200, 150.5],
  });
  // A payer key with colons (other builders) still parses from both ends.
  assertEquals(
    parseDebtDraftId(
      "2026-10-01:other_builder:Builderwest:deposit_reminder:deposit_reminder|100",
    )
      ?.step,
    "deposit_reminder",
  );
  for (
    const bad of [
      "",
      "nonsense",
      "2026-10-01:contact-a:text:friendly_text",
      "2026-10-01:contact-a:text:statement|100",
      "2026-10-01:contact-a:text:friendly_text|10.5",
      "2026-13-01:contact-a:text:friendly_text|100",
      "2026-10-01:contact-a:text:friendly_text|",
    ]
  ) {
    assertEquals(parseDebtDraftId(bad), null, bad);
  }
});
