// deno-lint-ignore-file no-explicit-any
import { DispatchError, readDispatchJob, uuid } from "./dispatch_workbench.ts";
import {
  assertOutlookSesDeliveryAllowed,
  fetchAttachment,
  graphRequest,
  verifyMailboxRoute,
} from "../send-outlook-email/index.ts";
export interface DispatchMailProvider {
  prepare(snapshot: any, actionId: string, jobId: string): Promise<any>;
  send(receipt: any): Promise<any>;
  readback(receipt: any): Promise<any>;
}
const check = (r: any) => {
  if (r.error) throw new DispatchError(r.error.message, 503);
  return r.data;
};
export async function executeDispatchDraft(
  client: any,
  org: string,
  b: any,
  provider: DispatchMailProvider,
  released = false,
  readJob = readDispatchJob,
) {
  uuid(b.job_id);
  uuid(b.draft_id);
  uuid(b.approval_id);
  if (!released) {
    return {
      action: { id: b.approval_id, status: "held" },
      live_actions_enabled: false,
    };
  }
  const job = await readJob(client, org, b.job_id),
    draft = job.drafts.find((d: any) => d.id === b.draft_id);
  if (
    !draft?.approval || draft.approval.id !== b.approval_id ||
    draft.approval.content_hash !== draft.content_hash ||
    draft.approval.source_version !== job.source_version
  ) throw new DispatchError("Exact current approval required", 409);
  const claim = check(
    await client.rpc("dispatch_claim_execution", {
      p_org: org,
      p_job: b.job_id,
      p_draft: b.draft_id,
      p_approval: b.approval_id,
      p_hash: draft.content_hash,
      p_source: job.source_version,
    }),
  );
  if (!claim.claimed) return { ...claim, live_actions_enabled: true };
  const persist = async (patch: any) =>
    check(
      await client.from("dispatch_executions").update({
        ...patch,
        updated_at: new Date().toISOString(),
      }).eq("org_id", org).eq("id", b.approval_id),
    );
  let receipt: any = null;
  try {
    // Recheck after claim before any provider mutation. SQL claim already binds
    // exact content, actor approval, source, job, order and attachment revisions.
    const latest = await readJob(client, org, b.job_id);
    if (
      latest.source_version !== job.source_version ||
      latest.drafts.find((d: any) => d.id === b.draft_id)?.content_hash !==
        draft.content_hash
    ) throw new Error("Source changed after claim");
    receipt = await provider.prepare(
      claim.action.snapshot,
      b.approval_id,
      b.job_id,
    );
    await persist({ status: "provider_draft_ready", receipt });
    const sent = await provider.send(receipt);
    await persist({
      status: "accepted_not_delivered",
      receipt: { ...receipt, ...sent },
    });
    return {
      action: {
        id: b.approval_id,
        status: "accepted_not_delivered",
        receipt: { ...receipt, ...sent },
      },
      live_actions_enabled: true,
    };
  } catch (e) {
    await persist({
      status: "outcome_unknown",
      receipt,
      last_error: (e as Error).message,
    });
    return {
      action: { id: b.approval_id, status: "outcome_unknown", receipt },
      retry_safe: false,
      readback_required: true,
    };
  }
}
export async function readbackDispatchExecution(
  client: any,
  org: string,
  id: string,
  provider: DispatchMailProvider,
) {
  const action = check(
    await client.from("dispatch_executions").select("*").eq("org_id", org).eq(
      "id",
      uuid(id),
    ).maybeSingle(),
  );
  if (!action) throw new DispatchError("Action not found", 404);
  if (!action.receipt) {
    return {
      action,
      readback_required: true,
      reason: "Provider identity unavailable; no automatic resend",
    };
  }
  const evidence = await provider.readback(action.receipt);
  check(
    await client.from("dispatch_executions").update({
      receipt: { ...action.receipt, readback: evidence },
      updated_at: new Date().toISOString(),
    }).eq("org_id", org).eq("id", id),
  );
  return {
    action: { ...action, receipt: { ...action.receipt, readback: evidence } },
    retry_safe: false,
  };
}
export function outlookDispatchProvider(
  client: any,
  allowedMailboxes: string[],
): DispatchMailProvider {
  const allowed = (mailbox: string) => {
    if (
      !allowedMailboxes.map((x) => x.toLowerCase()).includes(
        mailbox.toLowerCase(),
      )
    ) throw new Error("Mailbox not released for Dispatch");
  };
  const path = (r: any) =>
    `/users/${encodeURIComponent(r.mailbox)}/messages/${
      encodeURIComponent(r.draft_id)
    }`;
  const headers = {
    "Content-Type": "application/json",
    Prefer: 'IdType="ImmutableId"',
  };
  return {
    async prepare(d: any, id: string, jobId: string) {
      allowed(d.sender);
      // Captured Resend thread IDs cannot become native Outlook reply IDs.
      if (d.thread_id) {
        throw new Error(
          "Native reply requires verified mailbox message identity; captured PO thread is not an Outlook message",
        );
      }
      await assertOutlookSesDeliveryAllowed(client, {
        job_id: jobId,
        from: d.sender,
        to: d.to,
        cc: d.cc,
      });
      await verifyMailboxRoute(d.sender);
      const attachments = [];
      for (const a of d.attachments) {
        const file = await fetchAttachment(a.source_ref, a.name);
        const bytes = Uint8Array.from(
          atob(file.contentBytes),
          (c) => c.charCodeAt(0),
        );
        const digest = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (b) => b.toString(16).padStart(2, "0"),
        ).join("");
        if (a.revision.replace(/^sha256:/, "") !== digest) {
          throw new Error("Attachment revision changed");
        }
        attachments.push(file);
      }
      const response = await graphRequest(
        `/users/${encodeURIComponent(d.sender)}/messages`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            subject: d.subject,
            body: { contentType: "Text", content: d.body },
            toRecipients: d.to.map((address: string) => ({
              emailAddress: { address },
            })),
            ccRecipients: d.cc.map((address: string) => ({
              emailAddress: { address },
            })),
            attachments,
            internetMessageHeaders: [{
              name: "x-dispatch-action-id",
              value: id,
            }],
          }),
        },
        { mutating: true },
      );
      const message = await response.json();
      if (!message.id) throw new Error("Provider draft identity missing");
      return {
        mailbox: d.sender,
        draft_id: message.id,
        internet_message_id: message.internetMessageId || null,
        change_key: message.changeKey,
        content_hash: d.content_hash,
      };
    },
    async send(receipt: any) {
      allowed(receipt.mailbox);
      const check = await graphRequest(path(receipt), { headers }, {
        mutating: false,
      });
      const current = await check.json();
      if (
        current.isDraft !== true || current.changeKey !== receipt.change_key
      ) {
        throw new Error(
          "Provider draft changed or already sent; readback required",
        );
      }
      await graphRequest(path(receipt) + "/send", { method: "POST", headers }, {
        mutating: true,
      });
      return {
        provider_accepted: true,
        delivered: null,
        accepted_at: new Date().toISOString(),
      };
    },
    async readback(receipt: any) {
      allowed(receipt.mailbox);
      const r = await graphRequest(
        path(receipt) +
          "?$select=id,isDraft,internetMessageId,sentDateTime,changeKey",
        { headers },
        { mutating: false },
      );
      if (!r.ok) return { verified: false, status: r.status };
      const m = await r.json();
      return {
        verified: true,
        is_draft: m.isDraft,
        internet_message_id: m.internetMessageId,
        sent_at: m.sentDateTime,
        delivered: null,
      };
    },
  };
}
export async function dispatchExecutionState(
  client: any,
  org: string,
  jobId: string,
  released = false,
  canApprove = false,
) {
  await readDispatchJob(client, org, uuid(jobId));
  const rows = check(
    await client.from("dispatch_executions").select("*").eq("org_id", org).eq(
      "job_id",
      jobId,
    ).order("created_at", { ascending: false }).limit(101),
  ) || [];
  const control = check(
    await client.from("dispatch_release_controls").select("*").eq("org_id", org)
      .maybeSingle(),
  );
  return {
    actions: rows.slice(0, 100),
    coverage: { complete: rows.length <= 100 },
    capabilities: {
      release_hold: !released || !control?.communications_enabled,
      approval_enabled: canApprove,
      supported_transports: ["outlook_new"],
      captured_thread_send_available: false,
    },
  };
}
