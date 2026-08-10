/**
 * Recipient anchors for caller-supplied invoice destinations.
 *
 * Company anchors are server-owned values only: the linked make-safe company
 * row contributes its report_recipient and full-email sender_patterns entries.
 * Bare domains remain inbound matching patterns, not recipient addresses.
 */

type RecipientAnchorQueryResult = {
  data?: Record<string, unknown> | null;
  error?: { message: string } | null;
};

type RecipientAnchorClient = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): Promise<RecipientAnchorQueryResult>;
      };
    };
  };
};

export type CompanyRecipientAnchorRow = {
  report_recipient?: unknown;
  sender_patterns?: unknown;
};

export class RecipientAnchorLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipientAnchorLookupError";
  }
}

/** Normalise one full email address; domain-only patterns return null. */
export function normaliseFullEmail(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (
    !normalized || normalized.includes(",") ||
    normalized.split("@").length !== 2
  ) {
    return null;
  }
  const [local, domain] = normalized.split("@");
  if (!local || !domain || /\s/.test(local) || /\s/.test(domain)) return null;
  return normalized;
}

/** Add comma-separated email values from external contact records. */
export function addDelimitedEmails(set: Set<string>, value: unknown): boolean {
  if (typeof value !== "string") return false;
  let malformed = false;
  for (const part of value.split(",")) {
    const normalized = normaliseFullEmail(part);
    if (normalized) {
      set.add(normalized);
    } else if (part.trim()) {
      malformed = true;
    }
  }
  return malformed;
}

/** Resolve only the company-record anchors, never caller-provided values. */
export function companyRecipientAnchors(
  row: CompanyRecipientAnchorRow | null | undefined,
): Set<string> {
  const anchors = new Set<string>();
  const reportRecipient = normaliseFullEmail(row?.report_recipient);
  if (reportRecipient) anchors.add(reportRecipient);
  if (Array.isArray(row?.sender_patterns)) {
    for (const pattern of row.sender_patterns) {
      const address = normaliseFullEmail(pattern);
      if (address) anchors.add(address);
    }
  }
  return anchors;
}

/**
 * Company lookup is bound to the invoice mirror's linked job. A missing
 * make-safe detail is an ordinary non-company job and contributes no anchors.
 * Query failures throw so a broken company read cannot silently widen or
 * change the verification result.
 */
export async function loadCompanyRecipientAnchors(
  client: RecipientAnchorClient,
  verifiedJobId: string | null | undefined,
): Promise<Set<string>> {
  if (!verifiedJobId) return new Set<string>();

  const details = await client.from("makesafe_job_details")
    .select("requesting_company_id")
    .eq("job_id", verifiedJobId)
    .maybeSingle();
  if (details.error) {
    throw new RecipientAnchorLookupError(
      `make-safe company link lookup failed (${details.error.message})`,
    );
  }
  const companyId = String(details.data?.requesting_company_id || "").trim();
  if (!companyId) return new Set<string>();

  const company = await client.from("makesafe_companies")
    .select("report_recipient,sender_patterns")
    .eq("id", companyId)
    .maybeSingle();
  if (company.error) {
    throw new RecipientAnchorLookupError(
      `make-safe company anchor lookup failed (${company.error.message})`,
    );
  }
  return companyRecipientAnchors(company.data);
}

/**
 * Keep the existing Xero/job relationship rule while adding independent,
 * server-owned company anchors.
 */
export function buildExpectedRecipientSet(args: {
  xeroEmails: Set<string>;
  jobEmails: Set<string>;
  companyEmails: Set<string>;
}): Set<string> {
  const expected = new Set<string>(args.companyEmails);
  if (args.xeroEmails.size > 0) {
    for (const email of args.xeroEmails) expected.add(email);
    // A drifted jobs.client_email still cannot expand the Xero-confirmed set.
    for (const email of args.jobEmails) {
      if (args.xeroEmails.has(email)) expected.add(email);
    }
  } else {
    for (const email of args.jobEmails) expected.add(email);
  }
  return expected;
}
