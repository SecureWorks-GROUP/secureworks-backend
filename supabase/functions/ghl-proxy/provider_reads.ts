// Read-only provider pages. No Supabase client, cache, or mutation transport.
// Versioned contracts: https://marketplace.gohighlevel.com/docs/2021-07-28/ghl/
// Contacts GET is the documented 2023-02-21 compatibility endpoint (deprecated).
// Opportunities use v3: https://marketplace.gohighlevel.com/docs/ghl/opportunities/search-opportunity/
type JsonObject = Record<string, unknown>;
export const GHL_PROVIDER_READ_ACTIONS = [
  "read_ghl_location",
  "list_ghl_contacts",
  "list_ghl_opportunities",
  "list_ghl_conversations",
  "list_ghl_messages",
  "get_ghl_message",
  "get_ghl_email",
  "get_ghl_call_transcript",
] as const;
export type GhlProviderReadAction = typeof GHL_PROVIDER_READ_ACTIONS[number];
export function isGhlProviderReadAction(
  value: string | null,
): value is GhlProviderReadAction {
  return GHL_PROVIDER_READ_ACTIONS.some((action) => action === value);
}

export class GhlProviderReadError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public providerStatus?: number,
    public retryAfter?: string,
  ) {
    super(message);
  }
}

export function isDedicatedGhlReadServerKey(input: {
  action: string | null;
  xApiKey?: string | null;
  bearerToken?: string | null;
  agentServerKey?: string | null;
  sharedKey?: string | null;
  serviceKey?: string | null;
  routineKey?: string | null;
}): boolean {
  const key = input.agentServerKey;
  return isGhlProviderReadAction(input.action) && !!key &&
    ![input.sharedKey, input.serviceKey, input.routineKey].includes(key) &&
    (input.xApiKey === key || input.bearerToken === key);
}

export function assertGhlProviderReadCaller(input: {
  method: string;
  mode: string;
  role?: string | null;
  orgId?: string | null;
  configuredOrgId: string;
  testMode: boolean;
}) {
  if (input.method !== "GET") {
    throw new GhlProviderReadError(
      "method_not_allowed",
      "Provider reads require GET",
      405,
    );
  }
  if (input.testMode) {
    throw new GhlProviderReadError(
      "provider_read_test_route_refused",
      "Provider reads use the configured production location only",
      403,
    );
  }
  if (input.mode === "service_role") return;
  if (
    input.mode === "user_jwt" && input.orgId === input.configuredOrgId &&
    ["admin", "owner"].includes(input.role || "")
  ) return;
  throw new GhlProviderReadError(
    "provider_read_operator_required",
    "Provider reads require a server credential or same-organisation admin/owner",
    403,
  );
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}
function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function scalar(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : nonempty(value);
}
function requireId(value: unknown, label: string): string {
  const id = nonempty(value);
  if (!id || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) {
    throw new GhlProviderReadError(
      "invalid_identifier",
      `${label} must be a provider ID`,
    );
  }
  return id;
}
function optionalId(params: URLSearchParams, key: string): string | null {
  return params.has(key) ? requireId(params.get(key), key) : null;
}
function textArg(
  params: URLSearchParams,
  key: string,
  max = 200,
): string | null {
  if (!params.has(key)) return null;
  const value = params.get(key)!;
  if (
    !value.trim() || value.length > max ||
    [...value].some((char) => char.charCodeAt(0) < 32)
  ) {
    throw new GhlProviderReadError(
      "invalid_argument",
      `${key} must contain 1-${max} printable characters`,
    );
  }
  return value;
}
function intArg(
  params: URLSearchParams,
  key: string,
  fallback: number,
  max: number,
): number {
  if (!params.has(key)) return fallback;
  const value = params.get(key)!;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new GhlProviderReadError(
      "invalid_argument",
      `${key} must be an integer from 1 to ${max}`,
    );
  }
  return Number(value);
}
function rows(data: JsonObject, key: string): JsonObject[] {
  if (
    !Array.isArray(data[key]) ||
    data[key].some((row) =>
      !row || typeof row !== "object" || Array.isArray(row)
    )
  ) {
    throw new GhlProviderReadError(
      "provider_response_invalid",
      `Provider omitted the ${key} array`,
      502,
    );
  }
  return data[key] as JsonObject[];
}
function boundLocation(row: JsonObject, locationId: string) {
  if (row.locationId !== locationId) {
    throw new GhlProviderReadError(
      "provider_location_mismatch",
      "Provider record is not bound to the configured location",
      502,
    );
  }
}
function boundContact(row: JsonObject, contactId: string) {
  if ((row.contactId ?? object(row.contact).id) !== contactId) {
    throw new GhlProviderReadError(
      "provider_contact_mismatch",
      "Provider record does not belong to the requested contact",
      502,
    );
  }
}
function boundId(row: JsonObject, id: string) {
  if (row.id !== id) {
    throw new GhlProviderReadError(
      "provider_id_mismatch",
      "Provider returned a different record ID",
      502,
    );
  }
}

// Diagnostic-only allowlist: no provider scalar values or arbitrary keys escape.
// Kept inside the existing sanitized error message to avoid widening all errors.
function transcriptShape(value: unknown): JsonObject {
  let budget = 24;
  const keys = [
    "data",
    "result",
    "results",
    "transcription",
    "transcriptions",
    "transcript",
    "sentences",
    "mediaChannel",
    "sentenceIndex",
    "startTime",
    "endTime",
    "confidence",
  ];
  function shape(input: unknown, depth: number): JsonObject {
    if (--budget < 0) return { type: "omitted", bounded: true };
    const type = input === null
      ? "null"
      : Array.isArray(input)
      ? "array"
      : typeof input;
    if (type !== "object" && type !== "array") return { type };
    if (depth >= 4) return { type, bounded: true };
    if (Array.isArray(input)) {
      return {
        type,
        length: Math.min(input.length, 10000),
        ...(input.length > 10000 ? { length_capped: true } : {}),
        items: input.slice(0, 2).map((item) => shape(item, depth + 1)),
      };
    }
    const obj = object(input);
    const fields: JsonObject = {};
    for (const key of keys) {
      if (Object.hasOwn(obj, key)) fields[key] = shape(obj[key], depth + 1);
    }
    return { type, fields };
  }
  return shape(value, 0);
}

function transcriptValidationReason(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "sentence_not_object";
  }
  const sentence = object(value);
  if (!Object.hasOwn(sentence, "transcript")) return "missing_field:transcript";
  if (typeof sentence.transcript !== "string") return "invalid_type:transcript";
  if (!sentence.transcript.trim()) return "empty_transcript";
  for (
    const key of [
      "mediaChannel",
      "sentenceIndex",
      "startTime",
      "endTime",
      "confidence",
    ]
  ) {
    if (!Object.hasOwn(sentence, key)) return `missing_field:${key}`;
    const number = sentence[key];
    if (
      !((typeof number === "number" ||
        (typeof number === "string" && /^\d+(?:\.\d+)?$/.test(number))) &&
        Number.isFinite(Number(number)) && Number(number) >= 0)
    ) return `invalid_numeric:${key}`;
  }
  if (Number(sentence.endTime) < Number(sentence.startTime)) {
    return "reversed_timing";
  }
  if (!Number.isInteger(Number(sentence.mediaChannel))) {
    return "invalid_integer:mediaChannel";
  }
  if (!Number.isInteger(Number(sentence.sentenceIndex))) {
    return "invalid_integer:sentenceIndex";
  }
  if (Number(sentence.confidence) > 1) return "invalid_range:confidence";
  return null;
}

type Cursor = Record<string, string | number>;
function pagination(
  returned: number,
  limit: number,
  hasMore: boolean | null,
  cursor: Cursor | null,
  warning?: string,
) {
  return {
    returned,
    limit,
    has_more: hasMore,
    next_cursor: hasMore === false ? null : cursor,
    complete: hasMore === false,
    scope: "requested_page_and_filters",
    ...(warning ? { warning } : {}),
  };
}

const ARGUMENTS: Record<GhlProviderReadAction, string[]> = {
  read_ghl_location: [],
  list_ghl_contacts: ["query", "limit", "start_after", "start_after_id"],
  list_ghl_opportunities: [
    "query",
    "status",
    "pipeline_id",
    "contact_id",
    "limit",
    "page",
    "start_after",
    "start_after_id",
  ],
  list_ghl_conversations: ["contact_id", "limit", "start_after_date"],
  list_ghl_messages: [
    "contact_id",
    "conversation_id",
    "limit",
    "last_message_id",
  ],
  get_ghl_message: ["message_id", "contact_id", "conversation_id"],
  get_ghl_email: ["message_id", "contact_id", "conversation_id"],
  get_ghl_call_transcript: ["message_id", "contact_id", "conversation_id"],
};

export async function readGhlProvider(
  action: GhlProviderReadAction,
  params: URLSearchParams,
  options: {
    locationId: string;
    token: string;
    fetchFn?: typeof fetch;
    now?: () => Date;
  },
) {
  const { locationId, token } = options;
  if (!locationId || !token) {
    throw new GhlProviderReadError(
      "provider_not_configured",
      "GHL token and location must be configured",
      503,
    );
  }
  requireId(locationId, "configured location");
  for (const key of params.keys()) {
    if (
      !["action", "testMode", ...ARGUMENTS[action]].includes(key) ||
      params.getAll(key).length !== 1
    ) {
      throw new GhlProviderReadError(
        "unsupported_argument",
        `Unsupported or repeated argument: ${key}`,
      );
    }
  }
  const fetchFn = options.fetchFn || fetch;
  const deadline = Date.now() + 45000;
  const requests: { path: string; version: string; status: number }[] = [];
  async function getJson(
    path: string,
    query?: URLSearchParams,
    version = "2021-07-28",
  ): Promise<unknown> {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new GhlProviderReadError(
        "provider_read_budget_exceeded",
        "Provider read time limit reached; complete evidence was not fetched",
        504,
      );
    }
    const relative = `${path}${query?.size ? `?${query}` : ""}`;
    let response: Response;
    try {
      response = await fetchFn(
        `https://services.leadconnectorhq.com${relative}`,
        {
          method: "GET",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${token}`,
            Version: version,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(Math.min(15000, remainingMs)),
        },
      );
    } catch {
      throw new GhlProviderReadError(
        "provider_transport_failed",
        "GHL read failed or timed out",
        502,
      );
    }
    requests.push({ path: relative, version, status: response.status });
    if (!response.ok) {
      // Never echo provider error bodies: they can contain reflected credentials/content.
      await response.body?.cancel();
      throw new GhlProviderReadError(
        "provider_request_failed",
        `GHL returned HTTP ${response.status}`,
        response.status === 429 ? 429 : 502,
        response.status,
        response.headers.get("retry-after") || undefined,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new GhlProviderReadError(
        "provider_response_invalid",
        "GHL returned non-JSON content",
        502,
      );
    }
    return payload;
  }
  async function get(
    path: string,
    query?: URLSearchParams,
    version = "2021-07-28",
  ): Promise<JsonObject> {
    const payload = await getJson(path, query, version);
    if (
      payload === null || typeof payload !== "object" || Array.isArray(payload)
    ) {
      throw new GhlProviderReadError(
        "provider_response_invalid",
        "GHL returned an invalid object",
        502,
      );
    }
    return payload as JsonObject;
  }
  async function contact(id: string) {
    const response = await get(`/contacts/${encodeURIComponent(id)}`);
    const row = object(response.contact ?? response);
    boundId(row, id);
    boundLocation(row, locationId);
    return row;
  }
  async function conversation(id: string, contactId?: string | null) {
    const response = await get(`/conversations/${encodeURIComponent(id)}`);
    const row = object(response.conversation ?? response);
    boundId(row, id);
    boundLocation(row, locationId);
    if (contactId) boundContact(row, contactId);
    requireId(row.contactId, "conversation contactId");
    return row;
  }
  function result(
    data: JsonObject,
    page: ReturnType<typeof pagination> | null,
    extra: JsonObject = {},
  ) {
    return {
      success: true,
      source: "ghl_provider",
      location_id: locationId,
      retrieved_at: (options.now?.() || new Date()).toISOString(),
      data,
      pagination: page,
      provider_requests: requests,
      ...extra,
    };
  }
  const limit = intArg(params, "limit", 50, 100);

  if (action === "read_ghl_location") {
    const data = await get(`/locations/${encodeURIComponent(locationId)}`);
    boundId(object(data.location ?? data), locationId);
    return result(data, null);
  }
  if (action === "list_ghl_contacts" || action === "list_ghl_opportunities") {
    const isContacts = action === "list_ghl_contacts";
    const query = new URLSearchParams({
      locationId,
      limit: String(limit),
    });
    const search = textArg(params, "query", isContacts ? 200 : 75);
    if (search) query.set(isContacts ? "query" : "q", search);
    const after = textArg(params, "start_after", 40);
    const afterId = optionalId(params, "start_after_id");
    if (!!after !== !!afterId || (after && !/^\d+$/.test(after))) {
      throw new GhlProviderReadError(
        "invalid_cursor",
        "start_after epoch milliseconds and start_after_id must be supplied together",
      );
    }
    if (after && afterId) {
      query.set("startAfter", after);
      query.set("startAfterId", afterId);
    }
    let requestedContact: string | null = null;
    if (!isContacts) {
      if (params.has("page") && after) {
        throw new GhlProviderReadError(
          "invalid_cursor",
          "Use page or start-after cursor, not both",
        );
      }
      if (params.has("page")) {
        query.set("page", String(intArg(params, "page", 1, 1000000)));
      }
      for (
        const [key, providerKey] of [
          ["pipeline_id", "pipelineId"],
          ["contact_id", "contactId"],
        ]
      ) {
        const value = optionalId(params, key);
        if (value) query.set(providerKey, value);
      }
      const pipelineId = optionalId(params, "pipeline_id");
      if (pipelineId) {
        const pipelines = rows(
          await get(
            "/opportunities/pipelines",
            new URLSearchParams({ locationId }),
            "v3",
          ),
          "pipelines",
        );
        if (!pipelines.some((pipeline) => pipeline.id === pipelineId)) {
          throw new GhlProviderReadError(
            "pipeline_location_mismatch",
            "Pipeline is not in the configured location",
            400,
          );
        }
      }
      requestedContact = optionalId(params, "contact_id");
      if (requestedContact) await contact(requestedContact);
      const status = textArg(params, "status");
      if (
        status && !["open", "won", "lost", "abandoned", "all"].includes(status)
      ) {
        throw new GhlProviderReadError(
          "invalid_argument",
          "Unsupported opportunity status",
        );
      }
      query.set("status", status || "all");
    }
    const key = isContacts ? "contacts" : "opportunities";
    const data = await get(
      isContacts ? "/contacts/" : "/opportunities/search",
      query,
      isContacts ? "2023-02-21" : "v3",
    );
    const items = rows(data, key);
    for (const row of items) {
      boundLocation(row, locationId);
      if (requestedContact) boundContact(row, requestedContact);
      if (
        !isContacts && params.has("pipeline_id") &&
        row.pipelineId !== params.get("pipeline_id")
      ) {
        throw new GhlProviderReadError(
          "provider_pipeline_mismatch",
          "Provider ignored the requested pipeline",
          502,
        );
      }
    }
    const meta = object(data.meta);
    const nextAfter = scalar(meta.startAfter);
    const nextId = nonempty(meta.startAfterId);
    let cursor: Cursor | null = nextAfter && nextId
      ? { start_after: nextAfter, start_after_id: nextId }
      : null;
    const hasProviderNext = typeof meta.nextPage === "number" &&
      meta.nextPage > 0;
    const cursorMode = isContacts || after !== null;
    if (!cursor && !cursorMode && hasProviderNext) {
      cursor = { page: meta.nextPage as number };
    }
    if (!cursor && !cursorMode && items.length === limit) {
      cursor = { page: intArg(params, "page", 1, 1000000) + 1 };
    }
    // Cursor responses can retain nextPage: 2 after exhaustion. Do not use
    // that stale page counter to restart an opportunity cursor traversal.
    // Only an empty page with no cursor/URL signal proves cursor exhaustion;
    // incomplete or malformed signals must remain visible as incomplete.
    const hasCursorSignal = [
      meta.startAfter,
      meta.startAfterId,
      meta.nextPageUrl,
    ].some((value) => value !== null && value !== undefined && value !== "");
    const hasMore = cursorMode
      ? items.length === 0 && !hasCursorSignal
        ? false
        : hasCursorSignal || hasProviderNext
        ? true
        : null
      : hasProviderNext || !!nonempty(meta.nextPageUrl)
      ? true
      : items.length < limit
      ? false
      : null;
    const stalled = !!cursor && cursor.start_after === after &&
      cursor.start_after_id === afterId;
    if (stalled) cursor = null;
    return result(
      data,
      pagination(
        items.length,
        limit,
        hasMore,
        cursor,
        stalled
          ? "provider_cursor_stalled"
          : hasMore !== false && !cursor
          ? "provider_did_not_supply_a_usable_next_cursor"
          : undefined,
      ),
      {
        ...(isContacts
          ? {
            limitations: [
              "Deprecated provider GET endpoint retained for GET-only compatibility; no cache used",
            ],
          }
          : {
            stage_history: {
              status: "not_requested",
              note: "Current pipeline/stage fields are not transition history",
            },
          }),
      },
    );
  }
  const requestedContact = optionalId(params, "contact_id");
  const requestedConversation = optionalId(params, "conversation_id");
  if (action === "list_ghl_conversations") {
    if (!requestedContact) {
      throw new GhlProviderReadError(
        "contact_id_required",
        "contact_id is required",
      );
    }
    await contact(requestedContact);
    const query = new URLSearchParams({
      locationId,
      contactId: requestedContact,
      limit: String(limit),
      sort: "desc",
      sortBy: "last_message_date",
    });
    const after = textArg(params, "start_after_date", 80);
    if (after) query.set("startAfterDate", after);
    const data = await get("/conversations/search", query);
    const items = rows(data, "conversations");
    for (const row of items) {
      boundLocation(row, locationId);
      boundContact(row, requestedContact);
    }
    const last = items.at(-1);
    const next = scalar(last?.lastMessageDate ?? last?.last_message_date);
    const hasMore = items.length < limit ||
        (!after && typeof data.total === "number" && data.total <= items.length)
      ? false
      : null;
    const cursor = next && next !== after ? { start_after_date: next } : null;
    return result(
      data,
      pagination(
        items.length,
        limit,
        hasMore,
        cursor,
        hasMore !== false && !cursor
          ? "provider_did_not_supply_a_usable_next_cursor"
          : undefined,
      ),
    );
  }
  if (action === "list_ghl_messages") {
    if (!requestedContact || !requestedConversation) {
      throw new GhlProviderReadError(
        "conversation_scope_required",
        "contact_id and conversation_id are required",
      );
    }
    await contact(requestedContact);
    await conversation(requestedConversation, requestedContact);
    const query = new URLSearchParams({ limit: String(limit) });
    const after = optionalId(params, "last_message_id");
    if (after) {
      const cursorData = await get(
        `/conversations/messages/${encodeURIComponent(after)}`,
      );
      const cursorMessage = object(cursorData.message ?? cursorData);
      boundId(cursorMessage, after);
      boundLocation(cursorMessage, locationId);
      boundContact(cursorMessage, requestedContact);
      if (cursorMessage.conversationId !== requestedConversation) {
        throw new GhlProviderReadError(
          "provider_conversation_mismatch",
          "Cursor belongs to another conversation",
          502,
        );
      }
      query.set("lastMessageId", after);
    }
    const data = await get(
      `/conversations/${encodeURIComponent(requestedConversation)}/messages`,
      query,
    );
    const container = object(data.messages);
    const items = rows(container, "messages");
    for (const row of items) {
      boundLocation(row, locationId);
      boundContact(row, requestedContact);
      if (row.conversationId !== requestedConversation) {
        throw new GhlProviderReadError(
          "provider_conversation_mismatch",
          "Message belongs to another conversation",
          502,
        );
      }
    }
    const hasMore = typeof container.nextPage === "boolean"
      ? container.nextPage
      : null;
    const next = nonempty(container.lastMessageId);
    const cursor = next && next !== after ? { last_message_id: next } : null;
    return result(
      data,
      pagination(
        items.length,
        limit,
        hasMore,
        cursor,
        hasMore !== false && !cursor
          ? "provider_did_not_supply_a_usable_next_cursor"
          : undefined,
      ),
    );
  }
  const messageId = requireId(params.get("message_id"), "message_id");
  if (
    action === "get_ghl_call_transcript" &&
    (!requestedContact || !requestedConversation)
  ) {
    throw new GhlProviderReadError(
      "transcript_scope_required",
      "contact_id and conversation_id are required",
    );
  }
  if (
    action === "get_ghl_email" && (!requestedContact || !requestedConversation)
  ) {
    throw new GhlProviderReadError(
      "email_scope_required",
      "contact_id and conversation_id are required",
    );
  }
  if (!requestedContact && !requestedConversation) {
    throw new GhlProviderReadError(
      "message_scope_required",
      "contact_id or conversation_id is required",
    );
  }
  if (requestedContact) await contact(requestedContact);
  const scope = requestedConversation
    ? await conversation(requestedConversation, requestedContact)
    : null;
  const contactId = requestedContact ||
    requireId(scope?.contactId, "conversation contactId");
  const data = await get(
    `/conversations/messages/${encodeURIComponent(messageId)}`,
  );
  const message = object(data.message ?? data);
  boundId(message, messageId);
  boundLocation(message, locationId);
  boundContact(message, contactId);
  const conversationId = requireId(
    message.conversationId,
    "message conversationId",
  );
  if (requestedConversation && conversationId !== requestedConversation) {
    throw new GhlProviderReadError(
      "provider_conversation_mismatch",
      "Message belongs to another conversation",
      502,
    );
  }
  if (!requestedConversation) await conversation(conversationId, contactId);
  if (action === "get_ghl_call_transcript") {
    const typeMarkers = [message.type, message.typeString, message.messageType]
      .filter((value): value is string => typeof value === "string");
    if (
      !typeMarkers.length ||
      !typeMarkers.every((value) => ["TYPE_CALL", "CALL"].includes(value))
    ) {
      throw new GhlProviderReadError(
        "call_type_required",
        "Validated message is not unambiguously a call",
        422,
      );
    }
    const path = `/conversations/locations/${
      encodeURIComponent(locationId)
    }/messages/${encodeURIComponent(messageId)}/transcription`;
    // The v3 docs show a sentence object and numeric strings. Accept an array
    // of those same sentences, but never guess undocumented wrapper shapes.
    const raw = await getJson(path, undefined, "v3");
    const sentences = raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    for (const value of sentences) {
      const reason = transcriptValidationReason(value);
      if (reason) {
        const diagnostic = {
          reason,
          shape: transcriptShape(raw),
          invalid_sentence: transcriptShape(value),
        };
        throw new GhlProviderReadError(
          "provider_response_invalid",
          `GHL returned malformed transcript sentences; diagnostic=${
            JSON.stringify(diagnostic)
          }`,
          502,
        );
      }
    }
    return result(
      {
        message: data,
        transcript: {
          status: sentences.length ? "available" : "unavailable",
          sentences,
        },
      },
      null,
      {
        provenance: {
          contact_id: contactId,
          conversation_id: conversationId,
          message_id: messageId,
          message_occurred_at: message.dateAdded ?? null,
          endpoint: path,
          version: "v3",
        },
        media_coverage: {
          call: "validated",
          transcript: sentences.length
            ? "provider_sentences_returned"
            : "not_returned_by_provider",
          recording: "not_requested",
        },
        limitations: [
          "Provider transcript only; accuracy and completeness against the recording are not independently verified",
          ...(sentences.length
            ? []
            : ["Transcript unavailable; this does not mean no call occurred"]),
        ],
      },
    );
  }
  if (action === "get_ghl_email") {
    const emailMeta = object(object(message.meta).email);
    const references = object(emailMeta.email).messageIds ??
      emailMeta.messageIds;
    if (!Array.isArray(references) || !references.length) {
      throw new GhlProviderReadError(
        "email_reference_unavailable",
        "The validated message contains no provider email IDs",
        422,
      );
    }
    const emailIds = [
      ...new Set(references.map((id) => requireId(id, "provider email ID"))),
    ];
    if (emailIds.length > 50) {
      throw new GhlProviderReadError(
        "email_reference_limit",
        "Message contains more than 50 email references; complete details were not fetched",
        422,
      );
    }
    const emails: JsonObject[] = [];
    for (const emailId of emailIds) {
      const emailData = await get(
        `/conversations/messages/email/${encodeURIComponent(emailId)}`,
      );
      const email = object(emailData.email ?? emailData);
      boundId(email, emailId);
      boundLocation(email, locationId);
      boundContact(email, contactId);
      if (email.conversationId !== conversationId) {
        throw new GhlProviderReadError(
          "provider_conversation_mismatch",
          "Email belongs to another conversation",
          502,
        );
      }
      emails.push(emailData);
    }
    return result({ message: data, emails }, null, {
      email_reference_count: emailIds.length,
      email_details_complete: true,
      attachments: "provider_metadata_only_content_not_downloaded",
    });
  }
  return result(data, null, {
    media_coverage: {
      recording: message.recordingUrl || message.recording_url ||
          object(message.call).recordingUrl
        ? "present_in_provider_message"
        : "not_returned_in_message",
      transcript: message.transcript || message.transcription
        ? "present_in_provider_message"
        : "not_returned_in_message",
      attachments: "provider_metadata_only_content_not_downloaded",
      dedicated_recording_and_transcript_endpoints: "not_requested",
      email_details: "separate_email_details_not_requested",
    },
  });
}
