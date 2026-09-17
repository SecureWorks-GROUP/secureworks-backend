export class ContextPipelineError extends Error {
  constructor(public code: string, public status: number, message: string) {
    super(message);
  }
}

export async function contextPipelineStatus(
  client: { rpc: (fn: string) => PromiseLike<{ data: unknown; error: unknown }> },
) {
  const { data, error } = await client.rpc("context_pipeline_status");
  if (error || !data) {
    throw new ContextPipelineError(
      "context_status_unavailable",
      503,
      "Context pipeline status could not be read.",
    );
  }
  return data;
}
