// Read adapter only. Native M365 mailbox search is distinct from Resend/captured PO mail.
// https://learn.microsoft.com/en-us/graph/api/user-list-messages
import { graphRequest } from "../send-outlook-email/index.ts";
export async function dispatchOutlookSearch(
  params: URLSearchParams,
  allowedMailboxes: string[],
  request: typeof graphRequest = graphRequest,
) {
  const mailbox = (params.get("mailbox") || "").toLowerCase();
  if (!allowedMailboxes.map((x) => x.toLowerCase()).includes(mailbox)) {
    return {
      records: [],
      next_cursor: null,
      coverage: {
        complete: false,
        source: "Microsoft Graph",
        available: false,
        reason: "Mailbox is not configured for Dispatch read access",
      },
    };
  }
  const search = params.get("search") || "";
  if (!search.trim() || search.length > 200 || /["\\\r\n]/.test(search)) {
    throw new Error("Provide a plain search phrase up to 200 characters");
  }
  const base = `https://graph.microsoft.com/v1.0/users/${
    encodeURIComponent(mailbox)
  }/messages`;
  const initial = new URL(base);
  initial.searchParams.set("$top", "25");
  initial.searchParams.set("$search", `"${search}"`);
  initial.searchParams.set(
    "$select",
    "id,internetMessageId,conversationId,changeKey,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments,webLink",
  );
  let target = initial;
  if (params.get("cursor")) {
    target = new URL(params.get("cursor")!);
    // Never forward the app token to arbitrary URLs or another mailbox. Bind
    // continuation to this exact search and projection; retain whole Graph link.
    if (
      target.origin !== initial.origin ||
      target.pathname !== initial.pathname ||
      target.searchParams.get("$search") !==
        initial.searchParams.get("$search") ||
      target.searchParams.get("$select") !== initial.searchParams.get("$select")
    ) throw new Error("Invalid Outlook continuation");
  }
  const response = await request(target.toString(), {
    method: "GET",
    headers: {
      Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"',
    },
  }, { mutating: false });
  if (!response.ok) {
    return {
      records: [],
      next_cursor: null,
      coverage: {
        complete: false,
        available: false,
        source: "Microsoft Graph",
        reason: `Mailbox read failed (${response.status})`,
      },
    };
  }
  const data = await response.json();
  if (!Array.isArray(data.value)) throw new Error("Invalid mailbox response");
  return {
    records: data.value.map((r: Record<string, unknown>) => ({
      ...r,
      source: "microsoft_graph",
      mailbox,
      source_ref: {
        mailbox,
        graph_message_id: r.id,
        internet_message_id: r.internetMessageId,
        thread_id: r.conversationId,
      },
      job_id: null,
      attribution: "unlinked search result; explicit link required",
    })),
    next_cursor: data["@odata.nextLink"] || null,
    coverage: {
      complete: !data["@odata.nextLink"],
      has_more: !!data["@odata.nextLink"],
      available: true,
      source: "Microsoft Graph",
      mailbox,
      search,
      search_limit: 1000,
      reason:
        "Provider search is bounded; a result is not automatic job attribution",
    },
  };
}
