// deno-lint-ignore-file no-explicit-any
import { DispatchError, readDispatchJob, uuid } from "./dispatch_workbench.ts";
import {
  assertOutlookSesDeliveryAllowed,
  fetchAttachment,
  GraphProviderError,
  graphRequest,
  verifyMailboxRoute,
} from "../send-outlook-email/index.ts";
export interface DispatchMailProvider {
  prepare(snapshot: any, actionId: string, jobId: string): Promise<any>;
  send(receipt: any, beforeSend?: () => Promise<void>): Promise<any>;
  readback(receipt: any): Promise<any>;
}
const check = (r: any) => {
  if (r.error) throw new DispatchError(r.error.message, 503);
  return r.data;
};
const assertPurchaseAuthority = (draft: any) => {
  const requiresPurchaseApproval = Boolean(draft.po_id) ||
    draft.purchase_commitment !== false;
  if (
    requiresPurchaseApproval &&
    draft.approval?.purchase_approved !== true
  ) {
    throw new DispatchError(
      "Communications and supplier commitment approvals are separate",
      403,
    );
  }
};
export async function executeDispatchDraft(
  client: any,
  org: string,
  b: any,
  provider: DispatchMailProvider,
  released = false,
  readJob = readDispatchJob,
  releaseCheck = () => released,
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
  const job = structuredClone(await readJob(client, org, b.job_id)),
    draft = job.drafts.find((d: any) => d.id === b.draft_id);
  if (
    !draft?.approval || draft.approval.id !== b.approval_id ||
    draft.approval.content_hash !== draft.content_hash ||
    draft.approval.source_version !== job.source_version
  ) throw new DispatchError("Exact current approval required", 409);
  assertPurchaseAuthority(draft);
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
  if (!claim.claimed) {
    return {
      ...claim,
      live_actions_enabled: claim.action?.status === "held" ? false : true,
    };
  }
  let action = claim.action;
  const recordProgress = async (
    status: string,
    nextReceipt: any,
    error?: string,
  ) => {
    const result = check(
      await client.rpc("dispatch_record_execution_progress", {
        p_org: org,
        p_action: b.approval_id,
        p_expected_status: action.status,
        p_expected_receipt: action.receipt ?? null,
        p_expected_source: action.source_version,
        p_lease_token: action.lease_token ?? null,
        p_status: status,
        p_receipt: nextReceipt ?? null,
        p_error: error ?? null,
      }),
    );
    if (result.action) action = result.action;
    return result;
  };
  let receipt: any = null;
  let preparationStarted = false;
  try {
    const latest = await readJob(client, org, b.job_id);
    if (
      latest.source_version !== job.source_version ||
      latest.drafts.find((d: any) => d.id === b.draft_id)?.content_hash !==
        draft.content_hash
    ) {
      throw Object.assign(new Error("Source changed after claim"), {
        known_not_sent: true,
      });
    }
    preparationStarted = true;
    receipt = await provider.prepare(
      action.snapshot,
      b.approval_id,
      b.job_id,
    );
    const ready = await recordProgress("provider_draft_ready", receipt);
    if (!ready.recorded || action.status !== "provider_draft_ready") {
      return {
        action,
        retry_safe: false,
        readback_required: ready.readback_required,
      };
    }
    const beforeSend = await readJob(client, org, b.job_id);
    const currentDraft = beforeSend.drafts.find((d: any) =>
      d.id === b.draft_id
    );
    if (
      !releaseCheck() || beforeSend.source_version !== job.source_version ||
      currentDraft?.content_hash !== draft.content_hash ||
      JSON.stringify(currentDraft?.approval) !==
        JSON.stringify(action.snapshot.approval)
    ) {
      const stopped = await recordProgress(
        "not_sent",
        receipt,
        "Approval, source or release changed during preparation",
      );
      return {
        action,
        retry_safe: false,
        readback_required: stopped.readback_required,
      };
    }
    const finalClaim = check(
      await client.rpc("dispatch_begin_send", {
        p_org: org,
        p_action: b.approval_id,
        p_lease_token: action.lease_token ?? null,
      }),
    );
    if (finalClaim.action) action = finalClaim.action;
    if (!finalClaim.allowed) {
      return {
        action: finalClaim.action || action || {
          id: b.approval_id,
          status: "not_sent",
          receipt,
        },
        retry_safe: false,
        readback_required: action?.status === "outcome_unknown",
      };
    }
    const sent = await provider.send(receipt, async () => {
      const final = await readJob(client, org, b.job_id),
        current = final.drafts.find((d: any) => d.id === b.draft_id);
      if (
        !releaseCheck() || final.source_version !== job.source_version ||
        current?.content_hash !== draft.content_hash ||
        JSON.stringify(current?.approval) !==
          JSON.stringify(action.snapshot.approval)
      ) {
        throw Object.assign(new Error("Final send authority changed"), {
          known_not_sent: true,
        });
      }
      const fence = check(
        await client.rpc("dispatch_begin_send", {
          p_org: org,
          p_action: b.approval_id,
          p_lease_token: action.lease_token ?? null,
        }),
      );
      if (fence.action) action = fence.action;
      if (!fence.allowed) {
        throw Object.assign(new Error("Final send fence refused"), {
          action,
          known_not_sent: fence.reason === "approval_source_or_release_changed",
        });
      }
    });
    const mergedReceipt = { ...receipt, ...sent };
    const accepted = await recordProgress(
      "accepted_not_delivered",
      mergedReceipt,
    );
    return {
      action,
      live_actions_enabled: true,
      readback_required: accepted.readback_required,
    };
  } catch (e) {
    if ((e as any).action) action = (e as any).action;
    receipt = receipt || (e as any).receipt || action?.receipt || null;
    const status = !preparationStarted || (e as any).known_not_sent
      ? "not_sent"
      : "outcome_unknown";
    let recorded: any = null;
    if (!["accepted_not_delivered", "not_sent"].includes(action?.status)) {
      recorded = await recordProgress(status, receipt, (e as Error).message);
    }
    return {
      action,
      retry_safe: false,
      readback_required: recorded?.readback_required ??
        action?.status === "outcome_unknown",
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
    await client.rpc("dispatch_get_execution", {
      p_org: org,
      p_action: uuid(id),
    }),
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
  const recorded = check(
    await client.rpc("dispatch_record_execution_readback", {
      p_org: org,
      p_action: uuid(id),
      p_expected_status: action.status,
      p_expected_receipt: action.receipt,
      p_expected_source: action.source_version,
      p_readback: evidence,
    }),
  );
  return {
    action: recorded.action || {
      ...action,
      receipt: { ...action.receipt, readback: evidence },
    },
    retry_safe: false,
    readback_required: recorded.readback_required,
    readback_recorded: recorded.recorded,
  };
}
export function outlookDispatchProvider(
  client: any,
  allowedMailboxes: string[],
  deps = {
    request: graphRequest,
    guard: assertOutlookSesDeliveryAllowed,
    verify: verifyMailboxRoute,
    attachment: fetchAttachment,
  },
): DispatchMailProvider {
  const allowed = (mailbox: string) => {
    if (
      !allowedMailboxes.map((x) => x.toLowerCase()).includes(
        mailbox.toLowerCase(),
      )
    ) {
      throw Object.assign(new Error("Mailbox not released for Dispatch"), {
        known_not_sent: true,
      });
    }
  };
  const path = (r: any) =>
    `/users/${encodeURIComponent(r.mailbox)}/messages/${
      encodeURIComponent(r.draft_id)
    }`;
  const messageReadPath = (r: any) =>
    path(r) +
    "?$select=id,isDraft,from,sender,toRecipients,ccRecipients,bccRecipients," +
    "subject,body,changeKey";
  const headers = {
    "Content-Type": "application/json",
    Prefer: 'IdType="ImmutableId"',
  };
  const textReadHeaders = {
    ...headers,
    Prefer: `${headers.Prefer}, outlook.body-content-type="text"`,
  };
  const base64Text = (value: string) =>
    btoa(
      Array.from(new TextEncoder().encode(value), (byte) =>
        String.fromCharCode(byte)).join(""),
    );
  const replyMime = (draft: any) => {
    const subject = [];
    let part = "";
    for (const character of draft.subject) {
      if (new TextEncoder().encode(part + character).length > 45) {
        subject.push(`=?UTF-8?B?${base64Text(part)}?=`);
        part = "";
      }
      part += character;
    }
    subject.push(`=?UTF-8?B?${base64Text(part)}?=`);
    return base64Text([
      `From: ${draft.sender}`,
      `To: ${draft.to.join(",\r\n ")}`,
      ...(draft.cc.length ? [`Cc: ${draft.cc.join(",\r\n ")}`] : []),
      `Subject: ${subject.join("\r\n ")}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      "",
      base64Text(draft.body).match(/.{1,76}/g)?.join("\r\n") || "",
      "",
    ].join("\r\n"));
  };
  const addresses = (v: any[]) =>
    (v || []).map((x) => String(x.emailAddress?.address || "").toLowerCase())
      .sort();
  const expectedAddresses = (v: any[]) =>
    (v || []).map((x: string) => x.toLowerCase()).sort();
  const addressSetsEqual = (actual: any[], expected: any[]) =>
    JSON.stringify(addresses(actual)) === JSON.stringify(
      expectedAddresses(expected),
    );
  const mailboxMatches = (message: any, mailbox: string) => {
    const expected = mailbox.toLowerCase();
    return String(message.from?.emailAddress?.address || "").toLowerCase() ===
        expected &&
      String(message.sender?.emailAddress?.address || "").toLowerCase() ===
        expected;
  };
  const attachmentSignature = (a: any, requireId: boolean) =>
    JSON.stringify({
      id: requireId ? String(a.id || "") : "",
      odataType: String(a["@odata.type"] || ""),
      name: String(a.name || ""),
      contentType: String(a.contentType || ""),
      contentBytes: String(a.contentBytes || ""),
      isInline: a.isInline === true,
      contentId: String(a.contentId || ""),
    });
  const readDraftMessage = async (receipt: any) =>
    await (await deps.request(
      messageReadPath(receipt),
      { headers: textReadHeaders },
      { mutating: false },
    )).json();
  const assertMessageEnvelope = (current: any, receipt: any, d: any) => {
    if (
      current.id !== receipt.draft_id ||
      current.isDraft !== true ||
      typeof current.changeKey !== "string" || !current.changeKey ||
      !mailboxMatches(current, d.sender) ||
      !Array.isArray(current.toRecipients) ||
      !addressSetsEqual(current.toRecipients, d.to) ||
      !Array.isArray(current.ccRecipients) ||
      !addressSetsEqual(current.ccRecipients, d.cc) ||
      !Array.isArray(current.bccRecipients) ||
      !addressSetsEqual(current.bccRecipients, []) ||
      current.subject !== d.subject ||
      String(current.body?.content || "").replaceAll("\r\n", "\n") !==
        d.body.replaceAll("\r\n", "\n")
    ) {
      throw new Error(
        "Provider draft envelope differs from approved draft",
      );
    }
  };
  const readAttachmentDetails = async (receipt: any, expectedCount: number) => {
    const listed = await (await deps.request(
      path(receipt) +
        "/attachments?$select=id",
      { headers },
      { mutating: false },
    )).json();
    if (
      listed["@odata.nextLink"] || !Array.isArray(listed.value) ||
      listed.value.length !== expectedCount
    ) {
      throw new Error(
        "Provider draft attachments differ from approved draft",
      );
    }
    const details = [];
    for (const attachment of listed.value) {
      if (!attachment.id) {
        throw new Error(
          "Provider draft attachments differ from approved draft",
        );
      }
      const detail = await (await deps.request(
        path(receipt) + `/attachments/${encodeURIComponent(attachment.id)}`,
        { headers },
        { mutating: false },
      )).json();
      if (detail.id !== attachment.id) {
        throw new Error("Provider draft attachment identity changed");
      }
      details.push(detail);
    }
    return details;
  };
  const assertAttachmentEnvelope = (actual: any[], attachments: any[]) => {
    const requireId = attachments.some((a) => a.id);
    const expected = attachments.map((a) => attachmentSignature(a, requireId))
      .sort();
    if (
      actual.some((a) =>
        a["@odata.type"] !== "#microsoft.graph.fileAttachment" ||
        a.isInline === true ||
        typeof a.contentBytes !== "string"
      ) ||
      JSON.stringify(
          actual.map((a) => attachmentSignature(a, requireId)).sort(),
        ) !==
        JSON.stringify(expected)
    ) {
      throw new Error(
        "Provider draft attachments differ from approved draft",
      );
    }
  };
  const assertProviderEnvelope = async (
    receipt: any,
    d: any,
    attachments: any[],
  ) => {
    const beforeAttachments = await readDraftMessage(receipt);
    assertMessageEnvelope(beforeAttachments, receipt, d);
    const actualAttachments = await readAttachmentDetails(
      receipt,
      attachments.length,
    );
    const current = await readDraftMessage(receipt);
    assertMessageEnvelope(current, receipt, d);
    if (current.changeKey !== beforeAttachments.changeKey) {
      throw new Error(
        "Provider draft envelope changed during attachment validation",
      );
    }
    assertAttachmentEnvelope(actualAttachments, attachments);
    return current;
  };
  return {
    async prepare(d: any, id: string, jobId: string) {
      const attachments = [];
      let originalPath = "";
      try {
        allowed(d.sender);
        if (d.thread_id && !d.graph_message_id) {
          throw new Error(
            "Native reply requires verified mailbox message identity; captured PO thread is not an Outlook message",
          );
        }
        await deps.guard(
          client,
          d.graph_message_id
            ? {
              action: "reply",
              mailbox: d.sender,
              message_id: d.graph_message_id,
              job_id: jobId,
              expected_to: d.to,
              expected_cc: d.cc,
              reply_all: d.reply_all === true,
              attachments: d.attachments,
            }
            : {
              job_id: jobId,
              from: d.sender,
              to: d.to,
              cc: d.cc,
            },
        );
        await deps.verify(d.sender);
        for (const a of d.attachments) {
          const file = await deps.attachment(a.source_ref, a.name);
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
        if (d.graph_message_id) {
          originalPath = `/users/${encodeURIComponent(d.sender)}/messages/${
            encodeURIComponent(d.graph_message_id)
          }`;
          const source = await (await deps.request(
            originalPath + "?$select=id,conversationId,changeKey",
            { headers },
            { mutating: false },
          )).json();
          if (
            source.conversationId !== d.thread_id ||
            source.changeKey !== d.graph_change_key
          ) throw new Error("Native reply source identity/revision changed");
        }
      } catch (error) {
        throw Object.assign(error as Error, { known_not_sent: true });
      }
      if (d.graph_message_id) {
        const created = await (await deps.request(
          originalPath + (d.reply_all ? "/createReplyAll" : "/createReply"),
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "text/plain" },
            body: replyMime(d),
          },
          { mutating: true },
        )).json();
        if (!created.id) throw new Error("Native reply draft identity missing");
        const receipt = {
          mailbox: d.sender,
          draft_id: created.id,
          internet_message_id: created.internetMessageId || null,
          change_key: created.changeKey,
          content_hash: d.content_hash,
        };
        try {
          if (!receipt.change_key) {
            throw new Error("Native reply draft revision missing");
          }
          if (
            !addressSetsEqual(created.toRecipients, d.to) ||
            !addressSetsEqual(created.ccRecipients, d.cc)
          ) {
            throw new Error(
              "Native reply recipients differ from exact reviewed To/CC",
            );
          }
          const inherited = await (await deps.request(
            path(receipt) + "/attachments?$select=id",
            { headers },
            { mutating: false },
          )).json();
          if (inherited["@odata.nextLink"] || inherited.value?.length) {
            throw new Error(
              "Unexpected inherited reply attachments require separate review",
            );
          }
          assertMessageEnvelope(await readDraftMessage(receipt), receipt, d);
          const uploadedAttachments = [];
          for (const file of attachments) {
            const uploaded = await (await deps.request(
              path(receipt) + "/attachments",
              {
                method: "POST",
                headers,
                body: JSON.stringify(file),
              },
              { mutating: true },
            )).json();
            if (!uploaded.id) {
              throw new Error(
                "Provider draft attachments differ from approved draft",
              );
            }
            uploadedAttachments.push({ ...file, id: uploaded.id });
          }
          const current = await assertProviderEnvelope(
            receipt,
            d,
            uploadedAttachments.length ? uploadedAttachments : attachments,
          );
          return { ...receipt, change_key: current.changeKey };
        } catch (error) {
          throw Object.assign(error as Error, { receipt });
        }
      }
      const response = await deps.request(
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
      const receipt = {
        mailbox: d.sender,
        draft_id: message.id,
        internet_message_id: message.internetMessageId || null,
        change_key: message.changeKey,
        content_hash: d.content_hash,
      };
      try {
        if (!receipt.change_key) {
          throw new Error("Provider draft revision missing");
        }
        const current = await assertProviderEnvelope(receipt, d, attachments);
        return {
          ...receipt,
          change_key: current.changeKey,
        };
      } catch (error) {
        throw Object.assign(error as Error, { receipt });
      }
    },
    async send(receipt: any, beforeSend?: () => Promise<void>) {
      allowed(receipt.mailbox);
      const check = await deps.request(path(receipt), { headers }, {
        mutating: false,
      });
      const current = await check.json();
      if (
        current.id !== receipt.draft_id || current.isDraft !== true ||
        current.changeKey !== receipt.change_key
      ) {
        throw new Error(
          "Provider draft changed or already sent; readback required",
        );
      }
      if (beforeSend) await beforeSend();
      await deps.request(path(receipt) + "/send", { method: "POST", headers }, {
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
      let r: Response;
      try {
        r = await deps.request(
          path(receipt) +
            "?$select=id,isDraft,internetMessageId,sentDateTime,changeKey",
          { headers },
          { mutating: false },
        );
      } catch (error) {
        if (error instanceof GraphProviderError) {
          return { verified: false, status: error.status };
        }
        throw error;
      }
      const m = await r.json();
      return {
        verified: true,
        id: m.id,
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
  check(
    await client.rpc("dispatch_expire_execution_leases", {
      p_org: org,
      p_action: null,
    }),
  );
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
      supported_transports: ["outlook_new", "outlook_reply"],
      captured_thread_send_available: false,
    },
  };
}
