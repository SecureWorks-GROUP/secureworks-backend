// One log line per refused ops-api request (an ApiError answer): the action,
// the HTTP status and the refusal code, so "it would not let me" can be found
// in the function logs. Never the body, a message, a name, a figure or any
// text: the action comes from the request and a code can be any string, so
// each is printed only when it is a short identifier, else "-".

const IDENTIFIER = /^[a-z0-9_.:-]{1,80}$/i;

function token(value: unknown): string {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : "-";
}

export function opsApiRefusalLogLine(
  action: unknown,
  status: number,
  body: unknown,
): string {
  const code = body && typeof body === "object"
    ? (body as { code?: unknown }).code
    : undefined;
  const httpStatus = Number.isInteger(status) ? status : 0;
  return `[ops-api] refused action=${token(action)} status=${httpStatus} code=${
    token(code)
  }`;
}
