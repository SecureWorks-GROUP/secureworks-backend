// ── MAKE-SAFE ARRIVAL-TEXT NOTIFY (A5) ──────────────────────────────────────────
// When a genuine NEW work order first lands, text the owner crew ONCE:
//   * general / temp-fence / assessment make-safes -> the general recipients (Hugo)
//   * roof reports                                  -> the roof recipients (Hugo + Nithin)
// Fire-once is guaranteed by the makesafe_notify_log ledger (UNIQUE(org_id, dedup_key)):
// a twin capture, a re-send, or a re-extraction of the SAME WO collides on the key and
// is skipped. Recipients + the kill switch live in makesafe_notify_settings so the owner
// can change them with no code change.
//
// Owner-comms rule: NO em dashes in any outbound text (they read as AI-generated).
//
// All the routing / message / dedup logic is PURE (unit-tested); the DB read + ledger
// insert + SMS send are thin, injected wrappers.

export interface NotifySettings {
  notify_enabled: boolean;
  alarm_enabled: boolean;
  arrival_general_phones: string[];
  arrival_roof_phones: string[];
  alarm_phones: string[];
  from_number: string;
}

// Mirrors the migration seed. Used as the fail-safe default when the settings row is
// absent (pre-migration) so a config read failure never drops a real arrival text —
// it falls back to the seeded recipients rather than going silent.
export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = {
  notify_enabled: true,
  alarm_enabled: true,
  arrival_general_phones: ["+61400753169"], // Hugo
  arrival_roof_phones: ["+61400753169", "+61417795299"], // Hugo + Nithin
  alarm_phones: [], // seeded empty — owner alarm number not yet known
  from_number: "+61489267776", // SecureWorks Group Ops (a valid GHL sending number)
};

// Owner-comms rule: replace em/en/figure/horizontal-bar dashes with a plain hyphen.
export function stripDashes(s: string | null | undefined): string {
  return String(s ?? "").replace(/[‒–—―]/g, "-");
}

// Roof routing keys on the roof job family OR a committed roof report_type.
export function isRoofArrival(
  family: string | null | undefined,
  reportType: string | null | undefined,
): boolean {
  const f = String(family ?? "").toLowerCase();
  const r = String(reportType ?? "").toLowerCase();
  return f === "roof_report" || r === "roof_report";
}

// De-duplicated, blank-stripped recipient list for this WO's class.
export function arrivalRecipientsFor(
  family: string | null | undefined,
  reportType: string | null | undefined,
  settings: NotifySettings,
): string[] {
  const s = settings || DEFAULT_NOTIFY_SETTINGS;
  const list = isRoofArrival(family, reportType)
    ? s.arrival_roof_phones
    : s.arrival_general_phones;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of (list || [])) {
    const v = String(p ?? "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// Fire-once key: prefer the normalised external_ref (so twins / re-sends / re-extractions
// of the same WO collapse to ONE text); fall back to graph_message_id when no ref parsed.
export function arrivalDedupKey(
  externalRef: string | null | undefined,
  graphMessageId: string | null | undefined,
): string | null {
  const ref = String(externalRef ?? "").trim().toLowerCase().replace(/[\s#_-]+/g, "");
  if (ref) return `ref:${ref}`;
  const gid = String(graphMessageId ?? "").trim();
  if (gid) return `gmid:${gid}`;
  return null;
}

export interface ArrivalMessageInput {
  family?: string | null;
  reportType?: string | null;
  externalRef?: string | null;
  siteAddress?: string | null;
  siteSuburb?: string | null;
  companyName?: string | null;
}

// Short, plain, no em dashes, e.g.:
//   "New make-safe MLB-26678: 80 San Jacinta Rd, Seville Grove (ML Builders)"
//   "New roof report make-safe MLB-26910: 12 Hale St, Eaton (ML Builders)"
export function buildArrivalMessage(input: ArrivalMessageInput): string {
  const label = isRoofArrival(input.family, input.reportType)
    ? "roof report make-safe"
    : "make-safe";
  const ref = String(input.externalRef ?? "").trim();
  const addr = String(input.siteAddress ?? "").trim();
  const suburb = String(input.siteSuburb ?? "").trim();
  const company = String(input.companyName ?? "").trim();
  const addrLine = [addr, suburb].filter(Boolean).join(", ");
  let msg = `New ${label}`;
  if (ref) msg += ` ${ref}`;
  if (addrLine) msg += `: ${addrLine}`;
  if (company) msg += ` (${company})`;
  return stripDashes(msg).slice(0, 300);
}

// Whether an arrival text should even be attempted. The caller gates on the WO being a
// GENUINE NEW work order (never a reopen_candidate, never a dead-key degraded draft).
export function shouldSendArrival(input: {
  notifyEnabled: boolean;
  isReopen: boolean;
  extractionDegraded: boolean;
  hasDedupKey: boolean;
}): { ok: boolean; reason: string } {
  if (!input.notifyEnabled) return { ok: false, reason: "notify_disabled" };
  if (input.isReopen) return { ok: false, reason: "reopen_not_new_wo" };
  if (input.extractionDegraded) return { ok: false, reason: "extraction_degraded" };
  if (!input.hasDedupKey) return { ok: false, reason: "no_dedup_key" };
  return { ok: true, reason: "ok" };
}

// ── DB-bound: load settings (fail-safe to the seeded defaults) ──
export async function loadNotifySettings(client: any): Promise<NotifySettings> {
  try {
    const { data, error } = await client
      .from("makesafe_notify_settings")
      .select(
        "notify_enabled, alarm_enabled, arrival_general_phones, arrival_roof_phones, alarm_phones, from_number",
      )
      .eq("id", true)
      .maybeSingle();
    if (error || !data) return { ...DEFAULT_NOTIFY_SETTINGS };
    return {
      notify_enabled: data.notify_enabled !== false,
      alarm_enabled: data.alarm_enabled !== false,
      arrival_general_phones: Array.isArray(data.arrival_general_phones)
        ? data.arrival_general_phones
        : DEFAULT_NOTIFY_SETTINGS.arrival_general_phones,
      arrival_roof_phones: Array.isArray(data.arrival_roof_phones)
        ? data.arrival_roof_phones
        : DEFAULT_NOTIFY_SETTINGS.arrival_roof_phones,
      alarm_phones: Array.isArray(data.alarm_phones) ? data.alarm_phones : [],
      from_number: data.from_number || DEFAULT_NOTIFY_SETTINGS.from_number,
    };
  } catch {
    return { ...DEFAULT_NOTIFY_SETTINGS };
  }
}

export interface ArrivalSendInput {
  orgId: string;
  externalRef: string | null | undefined;
  graphMessageId: string | null | undefined;
  family: string | null | undefined;
  reportType: string | null | undefined;
  siteAddress: string | null | undefined;
  siteSuburb: string | null | undefined;
  companyName: string | null | undefined;
  jobId?: string | null;
}

export interface ArrivalSendDeps {
  // Sends one SMS to a raw E.164 phone; returns true on success. Injected so the pure
  // send-once logic is testable without GHL.
  sendSms: (phone: string, message: string, fromNumber: string) => Promise<boolean>;
  // Optional business_event breadcrumb writer (same signature as ops-api logBusinessEvent).
  logBusinessEvent?: (client: any, event: any) => Promise<void>;
}

export interface ArrivalSendResult {
  sent: boolean;
  reason: string;
  recipients: string[];
  message: string;
}

// Fire-once arrival send. Inserts the ledger row FIRST (race-safe fire-once); only sends
// when the insert wins. A 23505 collision means the WO was already texted (twin / re-send
// / re-extraction) -> skip. The caller must have already confirmed this is a genuine new
// WO (not a reopen / not degraded).
export async function sendMakesafeArrivalTexts(
  client: any,
  settings: NotifySettings,
  deps: ArrivalSendDeps,
  input: ArrivalSendInput,
): Promise<ArrivalSendResult> {
  const key = arrivalDedupKey(input.externalRef, input.graphMessageId);
  if (!settings.notify_enabled) {
    return { sent: false, reason: "notify_disabled", recipients: [], message: "" };
  }
  if (!key) {
    return { sent: false, reason: "no_dedup_key", recipients: [], message: "" };
  }

  const recipients = arrivalRecipientsFor(input.family, input.reportType, settings);
  const message = buildArrivalMessage({
    family: input.family,
    reportType: input.reportType,
    externalRef: input.externalRef,
    siteAddress: input.siteAddress,
    siteSuburb: input.siteSuburb,
    companyName: input.companyName,
  });

  // Fire-once ledger: insert before send. On a unique collision the WO is already done.
  const { error: logErr } = await client.from("makesafe_notify_log").insert({
    org_id: input.orgId,
    dedup_key: key,
    kind: "arrival",
    family: input.family ?? null,
    recipients,
    message,
  });
  if (logErr) {
    const code = String((logErr as any).code ?? "");
    if (code === "23505" || /duplicate|unique/i.test((logErr as any).message || "")) {
      return { sent: false, reason: "already_sent", recipients, message };
    }
    // Any other ledger error: do NOT send (cannot guarantee once-only) but never silent.
    console.warn("[ops-api] arrival notify_log insert failed; skipping send:", (logErr as any).message);
    return { sent: false, reason: "log_insert_failed", recipients, message };
  }

  if (!recipients.length) {
    return { sent: false, reason: "no_recipients", recipients, message };
  }

  let anySent = false;
  for (const phone of recipients) {
    try {
      const ok = await deps.sendSms(phone, message, settings.from_number);
      anySent = anySent || ok;
    } catch (e) {
      console.warn("[ops-api] arrival SMS send failed to", phone, (e as Error).message);
    }
  }

  if (deps.logBusinessEvent) {
    try {
      await deps.logBusinessEvent(client, {
        event_type: "makesafe.arrival_notified",
        source: "app/makesafe-intake",
        entity_type: "makesafe_ref",
        entity_id: String(input.externalRef || input.graphMessageId || "unknown"),
        job_id: input.jobId || undefined,
        body_preview: message,
        payload: {
          dedup_key: key,
          family: input.family ?? null,
          report_type: input.reportType ?? null,
          recipients,
          delivered: anySent,
        },
        metadata: { mission: "fix/makesafe-reextract-and-notify-2026-07-04" },
      });
    } catch { /* non-blocking breadcrumb */ }
  }

  return { sent: anySent, reason: anySent ? "sent" : "send_failed", recipients, message };
}
