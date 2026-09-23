export class ContextPipelineError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public reason: string,
  ) {
    super(message);
  }
}

type RpcError = { code?: unknown; message?: unknown; hint?: unknown };

// A short, non-secret token an operator can read in the 503 body: the
// Postgres SQLSTATE or PostgREST code (e.g. 42883, 57014, PGRST202). Anything
// else (a fetch failure has an empty code) collapses to a fixed token.
function rpcReasonCode(error: RpcError): string {
  const code = typeof error.code === "string" ? error.code.trim() : "";
  return /^[A-Za-z0-9_]{1,32}$/.test(code) ? code : "rpc_error_no_code";
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

export async function contextPipelineStatus(
  client: {
    rpc: (fn: string) => PromiseLike<{ data: unknown; error: unknown }>;
  },
) {
  const { data, error } = await client.rpc("context_pipeline_status");
  if (error || !data) {
    const rpcError =
      (error && typeof error === "object" ? error : {}) as RpcError;
    const reason = error ? rpcReasonCode(rpcError) : "empty_payload";
    // One structured line with the RPC error only, never the payload.
    console.error(JSON.stringify({
      event: "context_pipeline_status_rpc_failed",
      reason,
      code: text(rpcError.code),
      message: error ? text(rpcError.message) ?? String(error) : null,
      hint: text(rpcError.hint),
    }));
    throw new ContextPipelineError(
      "context_status_unavailable",
      503,
      "Context pipeline status could not be read.",
      reason,
    );
  }
  return data;
}
