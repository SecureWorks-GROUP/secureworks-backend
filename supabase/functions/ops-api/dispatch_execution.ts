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
  const persist = async (patch: any) =>
    check(
      await client.from("dispatch_executions").update({
        ...patch,
        updated_at: new Date().toISOString(),
      }).eq("org_id", org).eq("id", b.approval_id),
    );
  let receipt: any = null;
  let preparationStarted = false;
  try {
    // Recheck after claim before any provider mutation. SQL claim already binds
    // exact content, actor approval, source, job, order and attachment revisions.
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
      claim.action.snapshot,
      b.approval_id,
      b.job_id,
    );
    await persist({ status: "provider_draft_ready", receipt });
    const beforeSend = await readJob(client, org, b.job_id);
    const currentDraft = beforeSend.drafts.find((d: any) =>
      d.id === b.draft_id
    );
    if (
      !releaseCheck() || beforeSend.source_version !== job.source_version ||
      currentDraft?.content_hash !== draft.content_hash ||
      JSON.stringify(currentDraft?.approval) !==
        JSON.stringify(claim.action.snapshot.approval)
    ) {
      await persist({
        status: "not_sent",
        receipt,
        last_error: "Approval, source or release changed during preparation",
      });
      return {
        action: { id: b.approval_id, status: "not_sent", receipt },
        retry_safe: false,
      };
    }
    const finalClaim = check(
      await client.rpc("dispatch_begin_send", {
        p_org: org,
        p_action: b.approval_id,
      }),
    );
    if (!finalClaim.allowed) {
      return {
        action: { id: b.approval_id, status: "not_sent", receipt },
        retry_safe: false,
      };
    }
    const sent = await provider.send(receipt, async () => {
      const final = await readJob(client, org, b.job_id),
        current = final.drafts.find((d: any) => d.id === b.draft_id);
      if (
        !releaseCheck() || final.source_version !== job.source_version ||
        current?.content_hash !== draft.content_hash ||
        JSON.stringify(current?.approval) !==
          JSON.stringify(claim.action.snapshot.approval)
      ) {
        throw Object.assign(new Error("Final send authority changed"), {
          known_not_sent: true,
        });
      }
      const fence = check(
        await client.rpc("dispatch_begin_send", {
          p_org: org,
          p_action: b.approval_id,
        }),
      );
      if (!fence.allowed) {
        throw Object.assign(new Error("Final send fence refused"), {
          known_not_sent: true,
        });
      }
    });
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
    receipt = receipt || (e as any).receipt || null;
    const status = !preparationStarted || (e as any).known_not_sent
      ? "not_sent"
      : "outcome_unknown";
    await persist({
      status,
      receipt,
      last_error: (e as Error).message,
    });
    return {
      action: {
        id: b.approval_id,
        status,
        receipt,
      },
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
  const headers = {
    "Content-Type": "application/json",
    Prefer: 'IdType="ImmutableId"',
  };
  const textReadHeaders = {
    ...headers,
    Prefer: `${headers.Prefer}, outlook.body-content-type="text"`,
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
            headers,
            body: JSON.stringify({
              message: { body: { contentType: "Text", content: d.body } },
            }),
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
          const addresses = (v: any[]) =>
            (v || []).map((x) =>
              String(x.emailAddress?.address || "").toLowerCase()
            ).sort();
          if (
            JSON.stringify(addresses(created.toRecipients)) !==
              JSON.stringify(d.to.map((x: string) => x.toLowerCase()).sort()) ||
            JSON.stringify(addresses(created.ccRecipients)) !==
              JSON.stringify(
                d.cc.map((x: string) => x.toLowerCase()).sort(),
              )
          ) {
            throw new Error(
              "Native reply recipients differ from exact reviewed To/CC",
            );
          }
          await deps.request(path(receipt), {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              subject: d.subject,
              body: { contentType: "Text", content: d.body },
            }),
          }, { mutating: true });
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
          for (const file of attachments) {
            await deps.request(path(receipt) + "/attachments", {
              method: "POST",
              headers,
              body: JSON.stringify(file),
            }, { mutating: true });
          }
          const current = await (await deps.request(
            path(receipt),
            { headers: textReadHeaders },
            { mutating: false },
          )).json();
          if (
            current.subject !== d.subject ||
            String(current.body?.content || "").replaceAll("\r\n", "\n") !==
              d.body.replaceAll("\r\n", "\n")
          ) {
            throw new Error(
              "Provider reply content differs from approved draft",
            );
          }
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
      return {
        mailbox: d.sender,
        draft_id: message.id,
        internet_message_id: message.internetMessageId || null,
        change_key: message.changeKey,
        content_hash: d.content_hash,
      };
    },
    async send(receipt: any, beforeSend?: () => Promise<void>) {
      allowed(receipt.mailbox);
      const check = await deps.request(path(receipt), { headers }, {
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
