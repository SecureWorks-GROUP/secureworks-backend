/**
 * SAMPLE SES destination override.
 *
 * Live builder mailboxes must never receive SAMPLE traffic. When the docket
 * is a SAMPLE job, every sealed To/cc is rewritten to the single personal
 * inbox in SES_SAMPLE_DESTINATION_OVERRIDE (edge secret, not git). Missing or
 * builder-shaped override blanks the route so Send it cannot light.
 *
 * Mailbox strings are duplicated on purpose so this module does not import
 * the Graph gateway (the gateway calls assertSesSampleSendAllowed).
 */

export const SES_SAMPLE_DESTINATION_ENV = "SES_SAMPLE_DESTINATION_OVERRIDE";

const SAMPLE_JOB_NUMBER_RE = /^(SAMPLE|SWMS-SAMPLE)[-_]/i;

export const SES_LIVE_BUILDER_MAILBOXES: readonly string[] = [
  "workorders@ajs.build",
  "vanessa@ajs.build",
  "mandi@ajs.build",
  "mlb.mailer@primeeco.tech",
  "ses@secureworkswa.com.au",
  "makesafes@mlbuilders.com.au",
  "bunbury@mlbuilders.com.au",
  "workorders@secureworkswa.com.au",
  "builderwest.mailer@primeeco.tech",
  "accounts@westernbuild.com.au",
];

export type EnvGet = { get(key: string): string | undefined };

export function isSesSampleJobNumber(value: unknown): boolean {
  return SAMPLE_JOB_NUMBER_RE.test(String(value || "").trim());
}

export function isSesSampleDocket(
  docket: Record<string, any> | null | undefined,
): boolean {
  if (!docket) return false;
  if (
    docket.sample_only === true ||
    docket.metadata?.sample_only === true
  ) {
    return true;
  }
  const identity = docket.identity || docket.envelope?.v2?.identity || {};
  const lip = docket.local_invoice_proposal || {};
  const xero = docket.xero_binding || {};
  const candidates = [
    docket.job_number,
    identity.job_number,
    identity.builder_reference,
    identity.external_ref,
    lip.builder_reference,
    lip.reference,
    xero.reference,
  ];
  return candidates.some(isSesSampleJobNumber);
}

export function readSesSampleDestinationOverride(
  env: EnvGet = Deno.env,
): string {
  return String(env.get(SES_SAMPLE_DESTINATION_ENV) || "").trim();
}

function isUsablePersonalInbox(address: string): boolean {
  if (!address.includes("@") || address.includes(" ") || address.includes(",")) {
    return false;
  }
  return !SES_LIVE_BUILDER_MAILBOXES.includes(address.toLowerCase());
}

export function applySesSampleDestinationOverride<
  T extends { recipients: string[]; cc?: string[]; ready?: boolean },
>(
  docket: Record<string, any>,
  routes: T[],
  env: EnvGet = Deno.env,
): Array<
  T & {
    sample_destination_override: boolean;
    sample_destination_blocked: boolean;
  }
> {
  if (!isSesSampleDocket(docket)) {
    return routes.map((route) => ({
      ...route,
      sample_destination_override: false,
      sample_destination_blocked: false,
    }));
  }
  const dest = readSesSampleDestinationOverride(env);
  if (!isUsablePersonalInbox(dest)) {
    return routes.map((route) => ({
      ...route,
      recipients: [],
      cc: [],
      ready: false,
      sample_destination_override: false,
      sample_destination_blocked: true,
    }));
  }
  return routes.map((route) => ({
    ...route,
    recipients: [dest],
    cc: [],
    sample_destination_override: true,
    sample_destination_blocked: false,
  }));
}

/**
 * True when every stored release route is already the SAMPLE rewrite:
 * single personal-inbox To, blank cc. Used in tests and as a read of a
 * frozen envelope. Execute must not treat this shape alone as licence to
 * skip live AJS CC repair.
 */
export function sesReleaseUsesSampleDestinationOverride(
  routes: Array<{ recipients?: unknown; cc?: unknown }>,
  env: EnvGet = Deno.env,
): boolean {
  const dest = readSesSampleDestinationOverride(env).toLowerCase();
  if (!isUsablePersonalInbox(dest)) return false;
  if (!Array.isArray(routes) || routes.length === 0) return false;
  return routes.every((route) => {
    const recipients = (Array.isArray(route.recipients) ? route.recipients : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean);
    const cc = (Array.isArray(route.cc) ? route.cc : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    return recipients.length === 1 && recipients[0] === dest && cc.length === 0;
  });
}

export function assertSesSampleSendAllowed(route: Record<string, any>): void {
  if (route.sample_destination_blocked === true) {
    throw new Error(
      "SAMPLE send refused: SES_SAMPLE_DESTINATION_OVERRIDE is not a personal inbox",
    );
  }
  if (route.sample_destination_override !== true) return;
  const dests = [
    ...(Array.isArray(route.recipients) ? route.recipients : []),
    ...(Array.isArray(route.cc) ? route.cc : []),
  ].map((address) => String(address || "").trim().toLowerCase());
  if (dests.some((address) => SES_LIVE_BUILDER_MAILBOXES.includes(address))) {
    throw new Error(
      "SAMPLE send refused: envelope still names a live builder or ses@ mailbox",
    );
  }
  if (dests.length === 0) {
    throw new Error("SAMPLE send refused: no personal inbox on the envelope");
  }
}
