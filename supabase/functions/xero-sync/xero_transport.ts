import { xeroRateLimitError } from "../_shared/xero_cooldown.ts";

export class XeroSyncProviderError extends Error {
  constructor(readonly status: number, readonly path: string) {
    super(
      `Xero ${path} returned HTTP ${status}; the requested record is unverified`,
    );
    this.name = "XeroSyncProviderError";
  }
}

// The caller supplies the shared cooldown fetch. These transports never retry:
// especially an unkeyed write or an interrupted write has no duplicate guarantee.
export function createXeroSyncTransport(requestFetch: typeof fetch) {
  async function get(
    base: string,
    path: string,
    accessToken: string,
    tenantId: string,
    params?: Record<string, string>,
    extraHeaders?: Record<string, string>,
  ) {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, value);
    }
    const response = await requestFetch(url.toString().replace(/%2C/g, ","), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
        ...extraHeaders,
      },
    });
    if (response.status === 429) throw xeroRateLimitError(response);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new XeroSyncProviderError(response.status, path);
    }
    return response.json();
  }
  return {
    get: (
      path: string,
      accessToken: string,
      tenantId: string,
      params?: Record<string, string>,
      extraHeaders?: Record<string, string>,
    ) =>
      get(
        "https://api.xero.com/api.xro/2.0",
        path,
        accessToken,
        tenantId,
        params,
        extraHeaders,
      ),
    getProjects: (
      path: string,
      accessToken: string,
      tenantId: string,
      params?: Record<string, string>,
    ) =>
      get(
        "https://api.xero.com/projects.xro/2.0",
        path,
        accessToken,
        tenantId,
        params,
      ),
    async post(
      path: string,
      accessToken: string,
      tenantId: string,
      body: Record<string, unknown>,
      method: "POST" | "PUT" = "POST",
    ) {
      // Preserve a supplied key and the caller's object. Do not generate a new
      // key or delete the existing key before a potential caller retry.
      const { _idempotencyKey, ...payload } = body;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${accessToken}`,
        "Xero-tenant-id": tenantId,
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      if (typeof _idempotencyKey === "string" && _idempotencyKey) {
        headers["Idempotency-Key"] = _idempotencyKey;
      }
      const response = await requestFetch(
        `https://api.xero.com/api.xro/2.0${path}`,
        {
          method,
          headers,
          body: JSON.stringify(payload),
        },
      );
      if (response.status === 429) throw xeroRateLimitError(response);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new XeroSyncProviderError(response.status, path);
      }
      return response.json();
    },
  };
}
