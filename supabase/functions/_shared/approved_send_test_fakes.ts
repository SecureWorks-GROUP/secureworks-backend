// Test fakes for approved sends. Imported only by *_test.ts files.
//
// MemoryApprovedSendStore mirrors the database guards in
// 20260929100000_approved_send_approvals.sql: the approved content is
// immutable, status moves approved -> sending -> outcome only, claim is a
// compare-and-set, and the audit is append-only.

import {
  type ApprovalRow,
  type ApprovedSendStore,
  type AttachmentReader,
  type AttachmentRef,
  type AuditEntry,
  type RecordDeps,
  type RecorderIdentity,
  type SendDeps,
  type StoredFile,
} from "./approved_send.ts";
import { resolveSmsFromNumber } from "./sms_from_number.ts";

export const TEST_SEAL_SECRET = "test-service-role-key-for-seal";
export const RECORDER: RecorderIdentity = {
  credentialClass: "ops_agent_server_key",
  actor: "seat:rayleigh",
  actorSource: "header",
};

export class MemoryApprovedSendStore implements ApprovedSendStore {
  rows = new Map<string, ApprovalRow>();
  auditRows: (AuditEntry & { seq: number })[] = [];
  failAuditFor: Set<string> = new Set();
  private seq = 0;

  insertApproval(row: ApprovalRow): Promise<void> {
    if (this.rows.has(row.id)) throw new Error("duplicate id");
    if (row.status !== "approved") throw new Error("a new approval must start unclaimed");
    this.rows.set(row.id, structuredClone(row));
    return Promise.resolve();
  }
  loadApproval(id: string): Promise<ApprovalRow | null> {
    const row = this.rows.get(id);
    return Promise.resolve(row ? structuredClone(row) : null);
  }
  hasClaimAudit(id: string): Promise<boolean> {
    return Promise.resolve(
      this.auditRows.some((entry) => entry.approval_id === id && entry.event === "claimed"),
    );
  }
  claim(id: string, claimToken: string, nowIso: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== "approved" || Date.parse(row.expires_at) <= Date.parse(nowIso)) {
      return Promise.resolve(false);
    }
    row.status = "sending";
    row.claim_token = claimToken;
    row.claimed_at = nowIso;
    return Promise.resolve(true);
  }
  finish(
    id: string,
    claimToken: string,
    outcome: Parameters<ApprovedSendStore["finish"]>[2],
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== "sending" || row.claim_token !== claimToken) {
      return Promise.resolve(false);
    }
    row.status = outcome.status;
    row.outcome_at = outcome.at;
    row.outcome_code = outcome.code;
    row.provider_message_id = outcome.provider_message_id;
    row.provider_detail = outcome.provider_detail;
    return Promise.resolve(true);
  }
  audit(entry: AuditEntry): Promise<void> {
    if (this.failAuditFor.has(entry.event)) {
      return Promise.reject(new Error(`audit ${entry.event} refused by test`));
    }
    this.auditRows.push({ ...structuredClone(entry), seq: ++this.seq });
    return Promise.resolve();
  }
  listAudit(id: string): Promise<Record<string, unknown>[]> {
    return Promise.resolve(
      this.auditRows.filter((entry) => entry.approval_id === id) as unknown as Record<string, unknown>[],
    );
  }
  events(id: string | null = null): string[] {
    return this.auditRows.filter((entry) => id === null || entry.approval_id === id)
      .map((entry) => entry.event);
  }
}

export class MemoryFiles {
  files = new Map<string, StoredFile>();
  reads: string[] = [];

  static key(ref: AttachmentRef): string {
    return ref.source === "storage_object"
      ? `storage_object:${ref.bucket}/${ref.path}`
      : `${ref.source}:${ref.id}`;
  }
  put(ref: AttachmentRef, content: string, name: string | null, contentType: string | null = "application/pdf") {
    this.files.set(MemoryFiles.key(ref), {
      bytes: new TextEncoder().encode(content),
      name,
      content_type: contentType,
    });
  }
  reader(): AttachmentReader {
    return (ref) => {
      const key = MemoryFiles.key(ref);
      this.reads.push(key);
      const file = this.files.get(key);
      if (!file) return Promise.reject(new Error(`no stored file ${key}`));
      return Promise.resolve({ ...file, bytes: new Uint8Array(file.bytes) });
    };
  }
}

export class Clock {
  constructor(public ms: number) {}
  now = () => new Date(this.ms);
  advanceMinutes(minutes: number) {
    this.ms += minutes * 60_000;
  }
}

let idCounter = 0;
export function sequentialIds(): () => string {
  return () => {
    idCounter += 1;
    return `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`;
  };
}

export function makeDeps(
  store = new MemoryApprovedSendStore(),
  files = new MemoryFiles(),
  clock = new Clock(Date.parse("2026-09-29T02:00:00Z")),
): RecordDeps & SendDeps & { store: MemoryApprovedSendStore; files: MemoryFiles; clock: Clock } {
  return {
    store,
    files,
    clock,
    readAttachment: files.reader(),
    resolveFrom: resolveSmsFromNumber,
    sealSecret: TEST_SEAL_SECRET,
    now: clock.now,
    newId: sequentialIds(),
  };
}

export const OWNER_WORDS =
  "I did not approve that... we need to fully recode that so that if I give approval for agents to send stuff, they can send it";

export function smsApprovalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "sms",
    approved_by: "marnin",
    approved_at: "2026-09-29T01:55:00Z",
    approval_words: "Yes send Hugo: 'Running 10 min late, see you at 9:10'",
    approval_source: "firstmate main session 2026-09-29",
    sms: { to_mobile: "0412 345 678", message: "Running 10 min late, see you at 9:10" },
    ...overrides,
  };
}

export function emailApprovalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "email",
    approved_by: "marnin",
    approved_at: "2026-09-29T01:55:00Z",
    approval_words: OWNER_WORDS,
    approval_source: "firstmate main session 2026-09-29",
    email: {
      mailbox: "marnin@secureworkswa.com.au",
      mode: "reply",
      reply_to_message_id: "AAMkAGI-source-message",
      to: ["ambrose@example.com"],
      cc: ["shaun@secureworkswa.com.au"],
      bcc: [],
      subject: "RE: Fence at 12 Example St",
      html_body: "<p>Hi Ambrose, the revised quote is attached.</p>",
      attachments: [{ source: "job_document", id: "11111111-1111-4111-8111-111111111111" }],
    },
    ...overrides,
  };
}
