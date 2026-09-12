// deno-lint-ignore-file no-explicit-any
import {
  captureGroup,
  captureUser,
  type Cursor,
  type Mail,
  type Stream,
} from "./mail_capture.ts";
export interface ConfiguredStream {
  stream_key: string;
  enabled: boolean;
  unavailable_reason?: string | null;
}
/** One mailbox failure never hides remaining mailbox coverage. */
export async function runMailStreams(
  sb: any,
  get: (url: string) => Promise<Record<string, unknown>>,
  streams: ConfiguredStream[],
  persist: (mail: Mail, stream: Stream, url: string) => Promise<void>,
) {
  const coverage: Record<string, unknown>[] = [];
  const started = Date.now();
  for (const configured of streams) {
    const key = configured.stream_key;
    if (!configured.enabled) {
      coverage.push({
        stream: key,
        status: "unavailable",
        reason: configured.unavailable_reason,
      });
      continue;
    }
    if (Date.now() - started > 90000) {
      coverage.push({
        stream: key,
        status: "deferred",
        reason: "bounded_tick",
      });
      continue;
    }
    let state: Cursor = {}, lease: string | null = null, completed = false;
    try {
      const { data: claim, error: claimError } = await sb.rpc(
        "claim_context_mail_stream",
        { p_stream_key: key },
      );
      if (claimError) throw new Error("mail_stream_claim_failed");
      if (claim?.outcome !== "claimed") {
        coverage.push({
          stream: key,
          status: claim?.outcome || "claim_failed",
        });
        continue;
      }
      const row = claim.stream;
      lease = row.lease_token;
      state = row.state;
      const stream: Stream = {
        key,
        mailbox: row.mailbox,
        kind: row.kind,
        folder: row.folder,
        captureFrom: row.capture_from,
      };
      const checkpoint = async (next: Cursor, complete: boolean) => {
        const { data: ok, error } = await sb.rpc(
          "checkpoint_context_mail_stream",
          {
            p_stream_key: key,
            p_lease_token: lease,
            p_state: next,
            p_complete: complete,
            p_error: null,
            p_release: false,
          },
        );
        if (error || ok !== true) {
          throw new Error("mail_stream_checkpoint_lost_lease");
        }
        state = structuredClone(next);
        completed = complete;
      };
      const deps = {
        get,
        persist: (
          message: Mail,
          source: Stream,
          url: string,
        ) => persist(message, source, url),
        checkpoint,
        now: () => new Date().toISOString(),
      };
      const result = stream.kind === "group"
        ? await captureGroup(stream, state, deps)
        : await captureUser(stream, state, deps);
      if (!result.complete) {
        const { data: ok, error } = await sb.rpc(
          "checkpoint_context_mail_stream",
          {
            p_stream_key: key,
            p_lease_token: lease,
            p_state: state,
            p_complete: false,
            p_error: null,
            p_release: true,
          },
        );
        if (error || ok !== true) {
          throw new Error("mail_stream_release_failed");
        }
      }
      coverage.push({
        stream: key,
        status: result.complete ? "complete" : "continuing",
        ...result,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "capture_failed";
      let persisted = false;
      if (lease && !completed) {
        try {
          const { data: ok, error: writeError } = await sb.rpc(
            "checkpoint_context_mail_stream",
            {
              p_stream_key: key,
              p_lease_token: lease,
              p_state: state,
              p_complete: false,
              p_error: reason,
              p_release: true,
            },
          );
          persisted = !writeError && ok === true;
        } catch {
          persisted = false;
        }
      }
      coverage.push({
        stream: key,
        status: "error",
        reason,
        error_recorded: persisted,
      });
    }
  }
  return coverage;
}
