// Pure supplier credit note text parser (ticket P3-02.2).
// Deterministic string rules only: no network, no model, no database.
// Also holds the shared invoice number and amount helpers re-exported by
// xero-sync/materials_email_enrich.ts.

export interface ParsedSupplierCredit {
  credit_number: string;
  credit_date: string | null;
  amount_ex: number | null;
  amount_inc: number | null;
  names_bill_number: string | null;
}

const CREDIT_HEADING_RE =
  /\b(?:credit\s+note|adjustment\s+note|credit\s+memo)\b/i;
const STATEMENT_OR_REMITTANCE_RE = /\b(?:statement|remittance)\b/i;
const HEADER_STATEMENT_OR_REMITTANCE_RE =
  /\b(?:statement\s+of\s+account|account\s+statement|monthly\s+statement|remittance\s+advice|payment\s+remittance)\b/i;

const DATE_SHAPED_TOKEN_RE = /^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/;
const FILE_EXTENSION_AFTER_TOKEN_RE =
  /^\.(?:pdf|png|jpg|jpeg|tif|tiff|gif|webp|doc|docx|xls|xlsx|csv|txt|xml|html?)\b/i;
const DECIMAL_CENTS_AFTER_TOKEN_RE = /^\.\d{2}\b/;
const MONTH_AFTER_DAY_RE =
  /^\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;

function cleanDocumentToken(
  raw: string | undefined,
  afterMatchText: string,
  opts: { allowBareDayCheck?: boolean } = {},
): string | null {
  if (!raw) return null;
  if (FILE_EXTENSION_AFTER_TOKEN_RE.test(afterMatchText)) return null;
  if (DECIMAL_CENTS_AFTER_TOKEN_RE.test(afterMatchText)) return null;
  const cleaned = raw
    .replace(/^#+/, "")
    .replace(/[.,;:)\-_\/]+$/, "")
    .toUpperCase();
  if (!cleaned || !/\d/.test(cleaned)) return null;
  if (DATE_SHAPED_TOKEN_RE.test(cleaned)) return null;
  if (
    opts.allowBareDayCheck &&
    /^\d{1,2}$/.test(cleaned) &&
    MONTH_AFTER_DAY_RE.test(afterMatchText)
  ) {
    return null;
  }
  return cleaned;
}

function firstMatchingToken(
  text: string,
  patterns: ReadonlyArray<{ re: RegExp; bareHeading?: boolean }>,
): string | null {
  for (const { re, bareHeading } of patterns) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const globalRe = new RegExp(re.source, flags);
    let m: RegExpExecArray | null;
    while ((m = globalRe.exec(text)) !== null) {
      const after = text.slice(m.index + m[0].length);
      const token = cleanDocumentToken(m[1], after, {
        allowBareDayCheck: bareHeading,
      });
      if (token) return token;
    }
  }
  return null;
}

const INVOICE_NUMBER_PATTERNS: ReadonlyArray<{ re: RegExp }> = [
  {
    re:
      /Tax\s+Invoice\s*(?:No\.?|Number|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/gi,
  },
  {
    re: /Invoice\s*(?:No\.?|Number|#)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-\/]{3,})/gi,
  },
  {
    re: /\bINV[\-\s]?([A-Z0-9\-\/]{3,})/gi,
  },
];

// Best-effort invoice-number extraction across supplier invoice emails.
export function parseInvoiceNumber(text: string): string | null {
  if (!text) return null;
  return firstMatchingToken(text, INVOICE_NUMBER_PATTERNS);
}

const CREDIT_NUMBER_PATTERNS: ReadonlyArray<{
  re: RegExp;
  bareHeading?: boolean;
}> = [
  {
    re:
      /\b(?:credit\s+note\s+(?:number|no)|credit\s+memo\s+(?:number|no)|credit\s+(?:number|no)|adjustment\s+note\s+(?:number|no)|document\s+(?:number|no))(?:[ \t]*[.:#])*[ \t]*(?:\r?\n[ \t]*)?#?([A-Z0-9][A-Z0-9\-\/_]*)/gi,
  },
  {
    re:
      /\b(?:credit\s+note|adjustment\s+note|credit\s+memo)(?:[ \t]*[:#][ \t]*|[ \t]+)#?([A-Z0-9][A-Z0-9\-\/_]+)/gi,
    bareHeading: true,
  },
];

const NAMED_BILL_PATTERNS: ReadonlyArray<{ re: RegExp }> = [
  {
    re:
      /\b(?:original(?:\s+tax)?\s+invoice|against(?:\s+tax)?\s+invoice|re:?[\s]+(?:tax\s+)?invoice)(?:\s+(?:number|no\.?))?(?:[ \t]*[.:#])*[ \t]*(?:\r?\n[ \t]*)?#?([A-Z0-9][A-Z0-9\-\/_]*)/gi,
  },
  {
    re:
      /\b(?:tax\s+)?invoice\s+(?:number|no)(?:[ \t]*[.:#])*[ \t]*(?:\r?\n[ \t]*)?#?([A-Z0-9][A-Z0-9\-\/_]*)/gi,
  },
  {
    re:
      /\bapplies\s+to(?:\s+(?:tax\s+)?invoice(?:\s+(?:number|no\.?))?)?(?:[ \t]*[.:#])*[ \t]*(?:\r?\n[ \t]*)?#?([A-Z0-9][A-Z0-9\-\/_]*)/gi,
  },
];

const MONEY_CAPTURE =
  "(?:\\(\\s*\\$?\\s*([\\d,]+\\.\\d{2})\\s*\\)|-?\\s*\\$\\s*-?\\s*([\\d,]+(?:\\.\\d{2})?)|-?\\s*([\\d,]+\\.\\d{2}))";

const EX_GST_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(
    `\\bSub[\\s\\-]?total(?!\\s*\\(?inc\\b)(?:\\s*(?:\\(ex[^)]*\\)|ex(?:cl(?:uding)?\\.?)?\\s*gst))?\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
    "i",
  ),
  new RegExp(
    `(?<![A-Za-z\\-])(?:Credit\\s+Total|Total(?:\\s+Credit)?|Amount)\\s*(?:\\(ex[^)]*\\)|ex(?:cl(?:uding)?\\.?)?\\s*gst)\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
    "i",
  ),
];

const INC_GST_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(
    `(?<![A-Za-z\\-])(?:Credit\\s+Total|Total(?:\\s+(?:Credit|Due|Amount))?|Amount(?:\\s+Due)?)\\s*(?:\\(inc[^)]*\\)|inc(?:l(?:uding)?\\.?)?\\s*gst)\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
    "i",
  ),
  new RegExp(
    `(?<![A-Za-z\\-])(?:Credit\\s+Total|Total(?:\\s+(?:Due|Amount|Credit))?|Amount\\s+Due)(?!\\s*(?:\\(?ex(?:cl|\\b)|gst\\b))\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
    "i",
  ),
];

const TOTAL_GST_RE = new RegExp(
  `\\bTotal\\s+GST(?:\\s*(?:\\(\\s*10%\\s*\\)|@?\\s*10%))?\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
  "i",
);

const STANDALONE_GST_RE = new RegExp(
  `\\bGST\\b(?:\\s*(?:\\(\\s*10%\\s*\\)|@?\\s*10%))?\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
  "gi",
);

const GST_QUALIFIER_BEFORE_RE =
  /(?:\b(?:inc|incl|including|ex|excl|excluding|plus|less|no|without|free)\.?|\+)\s*\(?\s*$/i;

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function parseNonNegativeMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return roundCents(n);
}

function parsePositiveMoney(s: string | null | undefined): number | null {
  const n = parseNonNegativeMoney(s);
  return n !== null && n > 0 ? n : null;
}

function moneyGroup(m: RegExpMatchArray | null): string | null {
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function parseStandaloneGst(text: string): number | null {
  const totalGstMatch = TOTAL_GST_RE.exec(text);
  if (totalGstMatch) {
    return parseNonNegativeMoney(moneyGroup(totalGstMatch));
  }
  const re = new RegExp(STANDALONE_GST_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    if (GST_QUALIFIER_BEFORE_RE.test(before)) continue;
    const val = parseNonNegativeMoney(moneyGroup(m));
    if (val !== null) return val;
  }
  return null;
}

// Amount extraction: positive numbers only; a missing or zero total is null.
// When only one of ex-GST or inc-GST is explicitly labelled and a standalone
// GST amount is also present, derives the missing figure to the cent.
export function parseAmounts(
  text: string,
): { exGst: number | null; incGst: number | null } {
  if (!text) return { exGst: null, incGst: null };

  let exGst: number | null = null;
  for (const re of EX_GST_PATTERNS) {
    const val = parsePositiveMoney(moneyGroup(text.match(re)));
    if (val !== null) {
      exGst = val;
      break;
    }
  }

  let incGst: number | null = null;
  for (const re of INC_GST_PATTERNS) {
    const val = parsePositiveMoney(moneyGroup(text.match(re)));
    if (val !== null) {
      incGst = val;
      break;
    }
  }

  if (exGst === null && incGst !== null) {
    const gst = parseStandaloneGst(text);
    if (gst !== null) {
      const derived = roundCents(incGst - gst);
      exGst = derived > 0 ? derived : null;
    }
  } else if (incGst === null && exGst !== null) {
    const gst = parseStandaloneGst(text);
    if (gst !== null) {
      const derived = roundCents(exGst + gst);
      incGst = derived > 0 ? derived : null;
    }
  }

  return { exGst, incGst };
}

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const AU_DATE_CANDIDATE_RE =
  /(?<!\d)(?:(\d{1,2})([\/\-])(\d{1,2})\2(\d{4})|(\d{1,2})[\s\-]+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?[\s\-]+(\d{4}))(?!\d)/i;

function formatValidIsoDate(
  day: number,
  month: number,
  year: number,
): string | null {
  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    !Number.isInteger(year) ||
    year < 1900 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${
    String(day).padStart(2, "0")
  }`;
}

function parseCreditDate(text: string): string | null {
  const dateWord = /\bdate\b/i.exec(text);
  if (!dateWord) return null;
  const after = text.slice(dateWord.index + dateWord[0].length);
  const m = AU_DATE_CANDIDATE_RE.exec(after);
  if (!m) return null;
  if (m[1] !== undefined) {
    return formatValidIsoDate(Number(m[1]), Number(m[3]), Number(m[4]));
  }
  const month = MONTHS[m[6].toLowerCase()];
  if (!month) return null;
  return formatValidIsoDate(Number(m[5]), month, Number(m[7]));
}

export function parseSupplierCredit(text: string): ParsedSupplierCredit | null {
  if (!text || typeof text !== "string") return null;

  const head = text.slice(0, 1500);
  const creditHeading = CREDIT_HEADING_RE.exec(head);
  if (!creditHeading) return null;

  if (HEADER_STATEMENT_OR_REMITTANCE_RE.test(head.slice(0, 300))) return null;
  const stmtOrRemit = STATEMENT_OR_REMITTANCE_RE.exec(head);
  if (stmtOrRemit && stmtOrRemit.index < creditHeading.index) return null;

  const creditNumber = firstMatchingToken(text, CREDIT_NUMBER_PATTERNS);
  if (!creditNumber) return null;

  const namesBillNumber = firstMatchingToken(text, NAMED_BILL_PATTERNS);
  const creditDate = parseCreditDate(text);
  const amounts = parseAmounts(text);

  return {
    credit_number: creditNumber,
    credit_date: creditDate,
    amount_ex: amounts.exGst,
    amount_inc: amounts.incGst,
    names_bill_number: namesBillNumber,
  };
}
