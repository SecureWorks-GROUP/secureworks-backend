// Pure supplier credit note text parser (ticket P3-02.2).
// Deterministic string rules only: no network, no model, no database.
// Also holds the shared invoice number and amount helpers re-exported by
// xero-sync/materials_email_enrich.ts.

export interface ParsedSupplierCredit {
  credit_number: string;
  credit_date: string | null;
  amount_ex: number | null;
  amount_gst: number | null;
  amount_inc: number | null;
  names_bill_number: string | null;
  needs_review: boolean;
}

export interface ParsedCreditAmounts {
  exGst: number | null;
  gst: number | null;
  incGst: number | null;
  needsReview: boolean;
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

const EX_QUAL = "(?:\\(ex[^)]*\\)|ex(?:cl(?:uding)?\\.?)?\\s*gst)";
const INC_QUAL = "(?:\\(inc[^)]*\\)|inc(?:l(?:uding)?\\.?)?\\s*gst)";
const NOT_EX_OR_GST_AHEAD = "(?!\\s*(?:\\(?ex(?:cl|\\b)|gst\\b|tax\\b))";
const GST_RATE_QUAL =
  "(?:\\s*(?:\\(\\s*10%\\s*\\)|@?\\s*10%))?(?!\\s*[\\-\\s]?free\\b)";

const CREDIT_TOTAL_HEAD =
  "(?:Credit(?:\\s+(?:Note|Memo))?\\s+Total|Adjustment(?:\\s+Note)?\\s+Total|Total\\s+Credit(?:ed|\\s+Note|\\s+Amount)?|(?:Total\\s+)?Amount\\s+Credited|Credited\\s+Amount|Credit\\s+Amount|Net\\s+Credit)";

const CREDIT_INC_TOTAL_RE = new RegExp(
  `(?<![A-Za-z\\-])${CREDIT_TOTAL_HEAD}(?:\\s*${INC_QUAL}|${NOT_EX_OR_GST_AHEAD})\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
  "gi",
);

const GENERAL_INC_TOTAL_RE = new RegExp(
  `(?<![A-Za-z\\-])(?:(?:Total(?:\\s+(?:Due|Amount|Payable))?|Amount\\s+(?:Due|Payable))(?:\\s*${INC_QUAL}|${NOT_EX_OR_GST_AHEAD})|Amount\\s*${INC_QUAL})\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
  "gi",
);

const CREDIT_EX_TOTAL_RE = new RegExp(
  `(?<![A-Za-z\\-])(?:(?:Credit(?:\\s+(?:Note|Memo))?|Adjustment(?:\\s+Note)?)\\s+Sub[\\s\\-]?total(?!\\s*\\(?inc\\b)(?:\\s*${EX_QUAL})?|${CREDIT_TOTAL_HEAD}\\s*${EX_QUAL})\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
  "gi",
);

const GENERAL_EX_TOTAL_RE = new RegExp(
  `(?<![A-Za-z\\-])(?:Sub[\\s\\-]?total(?!\\s*\\(?inc\\b)(?:\\s*${EX_QUAL})?|(?:Total(?:\\s+Amount)?|Amount)\\s*${EX_QUAL})\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
  "gi",
);

const CREDIT_GST_TOTAL_RE = new RegExp(
  `(?<![A-Za-z\\-])(?:Credit(?:\\s+(?:Note|Memo))?\\s+(?:Total\\s+)?GST|Adjustment(?:\\s+Note)?\\s+(?:Total\\s+)?GST|Total\\s+Credit\\s+GST|Total\\s+GST\\s+Credited|GST\\s+Credited)${GST_RATE_QUAL}\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
  "gi",
);

const GENERAL_GST_TOTAL_RE = new RegExp(
  `(?<![A-Za-z\\-])(?:Total\\s+GST|GST\\s+Total)${GST_RATE_QUAL}\\s*:?\\s*(?:AUD\\s*)?${MONEY_CAPTURE}`,
  "gi",
);

const NON_TOTAL_PREFIX_RE =
  /\b(?:sub|line|item|unit|net|gst|tax|discount|credit(?:ed)?|adjustment)[\s\-]*$/i;
const CREDIT_DISQUALIFYING_PREFIX_RE = /\b(?:original|prior|previous)\s+$/i;
const INVOICE_TOTAL_PREFIX_RE =
  /\b(?:original(?:\s+tax)?(?:\s+invoice)?|tax\s+invoice|invoice|bill|purchase\s+order)\s+$/i;
const ORIGINAL_TOTAL_PREFIX_RE =
  /\b(?:original(?:\s+tax)?(?:\s+invoice)?)\s+$/i;

interface MoneyMatch {
  cents: number;
  index: number;
  end: number;
}

function toCents(n: number): number {
  return Math.round(n * 100);
}

function fromCents(cents: number): number {
  return cents / 100;
}

function parseNonNegativeCents(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(n) || n < 0) return null;
  return toCents(n);
}

function moneyGroup(m: RegExpMatchArray | null): string | null {
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function linePrefixBefore(text: string, index: number): string {
  const nl = text.lastIndexOf("\n", index - 1);
  const cr = text.lastIndexOf("\r", index - 1);
  const start = Math.max(nl, cr) + 1;
  return text.slice(start, index);
}

function collectMoneyMatches(
  text: string,
  re: RegExp,
  filterPrefix?: (beforeOnLine: string) => boolean,
): MoneyMatch[] {
  const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const out: MoneyMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(text)) !== null) {
    const before = linePrefixBefore(text, m.index);
    if (filterPrefix && !filterPrefix(before)) continue;
    const cents = parseNonNegativeCents(moneyGroup(m));
    if (cents !== null) {
      out.push({ cents, index: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

function allSameCents(matches: ReadonlyArray<MoneyMatch>): boolean {
  if (matches.length <= 1) return true;
  const first = matches[0].cents;
  return matches.every((m) => m.cents === first);
}

function filterToCreditSection(
  matches: ReadonlyArray<MoneyMatch>,
  sectionStart: number,
  incMatch: MoneyMatch | null,
  firstLaterRejected: MoneyMatch | null,
): MoneyMatch[] {
  return matches.filter((m) => {
    if (m.index < sectionStart) return false;
    if (incMatch && firstLaterRejected && m.index >= incMatch.end) {
      const distToCredit = m.index - incMatch.end;
      const distToRejected = firstLaterRejected.index - m.end;
      if (distToCredit >= distToRejected) return false;
    }
    return true;
  });
}

function parseAmountsInternal(
  text: string,
  opts: { isCredit: boolean },
): ParsedCreditAmounts {
  const empty: ParsedCreditAmounts = {
    exGst: null,
    gst: null,
    incGst: null,
    needsReview: false,
  };
  if (!text) return empty;
  const review: ParsedCreditAmounts = {
    exGst: null,
    gst: null,
    incGst: null,
    needsReview: true,
  };

  // 1. Resolve inc-GST total: credit/amount-credited labelled first (refusing
  //    if two candidates differ), else the last general total in document order.
  const creditIncMatches = opts.isCredit
    ? collectMoneyMatches(
      text,
      CREDIT_INC_TOTAL_RE,
      (before) => !CREDIT_DISQUALIFYING_PREFIX_RE.test(before),
    )
    : [];
  if (!allSameCents(creditIncMatches)) return review;

  const invoicePrefixedIncSpans: MoneyMatch[] = [];
  const generalIncMatches = collectMoneyMatches(
    text,
    GENERAL_INC_TOTAL_RE,
    (before) => {
      if (NON_TOTAL_PREFIX_RE.test(before)) return false;
      if (opts.isCredit && INVOICE_TOTAL_PREFIX_RE.test(before)) {
        return false;
      }
      if (!opts.isCredit && ORIGINAL_TOTAL_PREFIX_RE.test(before)) {
        return false;
      }
      return true;
    },
  );
  if (opts.isCredit) {
    const rawGeneral = collectMoneyMatches(
      text,
      GENERAL_INC_TOTAL_RE,
      (before) =>
        !NON_TOTAL_PREFIX_RE.test(before) && INVOICE_TOTAL_PREFIX_RE.test(before),
    );
    invoicePrefixedIncSpans.push(...rawGeneral);
  }

  const chosenIncMatch: MoneyMatch | null = creditIncMatches.length > 0
    ? creditIncMatches[creditIncMatches.length - 1]
    : generalIncMatches.length > 0
    ? generalIncMatches[generalIncMatches.length - 1]
    : null;

  const rejectedIncSpans: MoneyMatch[] = chosenIncMatch
    ? [
      ...invoicePrefixedIncSpans,
      ...generalIncMatches.filter((m) => m.cents !== chosenIncMatch.cents),
    ].sort((a, b) => a.index - b.index)
    : invoicePrefixedIncSpans.sort((a, b) => a.index - b.index);

  let sectionStart = 0;
  let firstLaterRejected: MoneyMatch | null = null;
  if (chosenIncMatch) {
    for (const r of rejectedIncSpans) {
      if (r.end <= chosenIncMatch.index && r.end > sectionStart) {
        sectionStart = r.end;
      } else if (r.index >= chosenIncMatch.end && !firstLaterRejected) {
        firstLaterRejected = r;
      }
    }
  } else if (rejectedIncSpans.length > 0) {
    sectionStart = rejectedIncSpans[rejectedIncSpans.length - 1].end;
  }

  // 2. Resolve ex-GST total (credit-labelled first, refusing if two differ;
  //    else last in the credit section).
  const creditExMatches = opts.isCredit
    ? collectMoneyMatches(
      text,
      CREDIT_EX_TOTAL_RE,
      (before) => !CREDIT_DISQUALIFYING_PREFIX_RE.test(before),
    )
    : [];
  if (!allSameCents(creditExMatches)) return review;

  const generalExMatches = filterToCreditSection(
    collectMoneyMatches(
      text,
      GENERAL_EX_TOTAL_RE,
      (before) => {
        if (/\b(?:line|item|unit|credit(?:ed)?|adjustment)[\s\-]*$/i.test(before)) {
          return false;
        }
        if (opts.isCredit && INVOICE_TOTAL_PREFIX_RE.test(before)) return false;
        if (!opts.isCredit && ORIGINAL_TOTAL_PREFIX_RE.test(before)) return false;
        return true;
      },
    ),
    sectionStart,
    chosenIncMatch,
    firstLaterRejected,
  );

  const chosenExMatch: MoneyMatch | null = creditExMatches.length > 0
    ? creditExMatches[creditExMatches.length - 1]
    : generalExMatches.length > 0
    ? generalExMatches[generalExMatches.length - 1]
    : null;

  // 3. Resolve document-level GST total only (never bare/line GST).
  const creditGstMatches = opts.isCredit
    ? collectMoneyMatches(
      text,
      CREDIT_GST_TOTAL_RE,
      (before) => !CREDIT_DISQUALIFYING_PREFIX_RE.test(before),
    )
    : [];
  if (!allSameCents(creditGstMatches)) return review;

  const generalGstMatches = filterToCreditSection(
    collectMoneyMatches(
      text,
      GENERAL_GST_TOTAL_RE,
      (before) => {
        if (NON_TOTAL_PREFIX_RE.test(before)) return false;
        if (opts.isCredit && INVOICE_TOTAL_PREFIX_RE.test(before)) return false;
        if (!opts.isCredit && ORIGINAL_TOTAL_PREFIX_RE.test(before)) return false;
        return true;
      },
    ),
    sectionStart,
    chosenIncMatch,
    firstLaterRejected,
  );
  if (chosenIncMatch && !allSameCents(generalGstMatches) && creditGstMatches.length === 0) {
    return review;
  }

  const chosenGstMatch: MoneyMatch | null = creditGstMatches.length > 0
    ? creditGstMatches[creditGstMatches.length - 1]
    : generalGstMatches.length > 0
    ? generalGstMatches[generalGstMatches.length - 1]
    : null;

  let exCents: number | null = chosenExMatch ? chosenExMatch.cents : null;
  const gstCents: number | null = chosenGstMatch ? chosenGstMatch.cents : null;
  let incCents: number | null = chosenIncMatch ? chosenIncMatch.cents : null;

  // 4. Cross-check ex + GST against inc (tolerance: 1 cent), or derive a
  //    missing figure only from a document-level GST total.
  if (exCents !== null && incCents !== null && gstCents !== null) {
    if (Math.abs(exCents + gstCents - incCents) > 1) {
      return review;
    }
    if ((incCents > 0 && exCents <= 0) || (exCents > 0 && incCents <= 0)) {
      return review;
    }
  } else if (exCents !== null && incCents !== null) {
    if (exCents - incCents > 1) {
      return review;
    }
    if ((incCents > 0 && exCents <= 0) || (exCents > 0 && incCents <= 0)) {
      return review;
    }
  } else if (exCents === null && incCents !== null && gstCents !== null) {
    if (incCents === 0 && gstCents === 0) {
      incCents = null;
    } else {
      const derivedEx = incCents - gstCents;
      if (derivedEx <= 0) {
        return review;
      }
      exCents = derivedEx;
    }
  } else if (incCents === null && exCents !== null && gstCents !== null) {
    if (exCents === 0 && gstCents === 0) {
      exCents = null;
    } else if (exCents <= 0 && gstCents > 0) {
      return review;
    } else {
      incCents = exCents + gstCents;
    }
  }

  const finalEx = exCents !== null && exCents > 0 ? fromCents(exCents) : null;
  const finalInc = incCents !== null && incCents > 0 ? fromCents(incCents) : null;
  const finalGst = gstCents !== null && (finalEx !== null || finalInc !== null)
    ? fromCents(gstCents)
    : null;

  return {
    exGst: finalEx,
    gst: finalGst,
    incGst: finalInc,
    needsReview: false,
  };
}

export function parseCreditAmounts(text: string): ParsedCreditAmounts {
  return parseAmountsInternal(text, { isCredit: true });
}

// Amount extraction: positive numbers only; a missing or zero total is null.
// Derives a missing ex/inc figure only when a document-level GST total is
// present, and withholds amounts when ex + GST mismatches inc beyond one cent.
export function parseAmounts(
  text: string,
): { exGst: number | null; incGst: number | null } {
  if (!text) return { exGst: null, incGst: null };
  const isCredit = CREDIT_HEADING_RE.test(text.slice(0, 1500));
  const res = parseAmountsInternal(text, { isCredit });
  return { exGst: res.exGst, incGst: res.incGst };
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
  const amounts = parseCreditAmounts(text);

  return {
    credit_number: creditNumber,
    credit_date: creditDate,
    amount_ex: amounts.exGst,
    amount_gst: amounts.gst,
    amount_inc: amounts.incGst,
    names_bill_number: namesBillNumber,
    needs_review: amounts.needsReview,
  };
}
