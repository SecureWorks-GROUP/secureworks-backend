// Isolated worker for the shutdown proof. The first capture deliberately never
// finishes, leaving the real HTTP handler's second accepted request queued.
// No provider, database or credential access occurs in this worker.
import { handleCapture } from "../../functions/outlook-mail-capture/handler.ts";
import type {
  CaptureRequest,
  CaptureResult,
} from "../../functions/outlook-mail-capture/capture.ts";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<Record<string, unknown>>) => void;
  postMessage(value: unknown): void;
};
scope.onmessage = async (event) => {
  const started: Array<string | null> = [];
  let clients = 0;
  const deps = {
    env: (name: string) =>
      name === "SW_API_KEY" ? "shutdown-fixture" : undefined,
    createSupabase: () => {
      clients++;
      return {};
    },
    waitUntil: (_promise: Promise<unknown>) => {},
  };
  const request = (body: Record<string, unknown>) =>
    new Request("https://fixture.invalid/outlook-mail-capture", {
      method: "POST",
      headers: { "x-api-key": "shutdown-fixture" },
      body: JSON.stringify(body),
    });
  const run = (_deps: unknown, body: CaptureRequest) => {
    started.push(body.source ?? null);
    return new Promise<CaptureResult>(() => {});
  };
  const first = await handleCapture(
    request({ mode: "poll", source: "blocking_fixture" }),
    deps,
    run,
  );
  const queued = await handleCapture(request(event.data), deps, run);
  scope.postMessage({
    first_status: first.status,
    queued_status: queued.status,
    started,
    clients,
  });
};
