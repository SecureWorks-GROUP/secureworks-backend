import { encodeBase64, type SyntheticFixture } from "./fixtures.ts";

export interface LivefireConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  opsApiKey: string;
}

export class LivefireHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${operation} failed: HTTP ${status}: ${detail}`);
  }
}

function inFilter(values: readonly string[]): string {
  return `in.(${
    values.map((value) => `"${value.replaceAll('"', '\\"')}"`).join(",")
  })`;
}

export class LivefireClient {
  constructor(readonly config: LivefireConfig) {}

  private headers(extra: HeadersInit = {}): Headers {
    const headers = new Headers(extra);
    headers.set("apikey", this.config.serviceRoleKey);
    headers.set("authorization", `Bearer ${this.config.serviceRoleKey}`);
    return headers;
  }

  async rest<T>(
    table: string,
    query: Record<string, string> = {},
    init: RequestInit = {},
  ): Promise<T> {
    const url = new URL(`/rest/v1/${table}`, this.config.supabaseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      ...init,
      headers: this.headers({
        "content-type": "application/json",
        prefer: "return=representation",
        ...(init.headers || {}),
      }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new LivefireHttpError(
        `${init.method || "GET"} ${table}`,
        response.status,
        text,
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async action<T>(
    slug: string,
    action: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`/functions/v1/${slug}`, this.config.supabaseUrl);
    url.searchParams.set("action", action);
    const method = options.method ||
      (options.body === undefined ? "GET" : "POST");
    const response = await fetch(url, {
      method,
      headers: this.headers({
        "content-type": "application/json",
        "x-api-key": this.config.opsApiKey,
      }),
      body: options.body === undefined
        ? undefined
        : JSON.stringify(options.body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new LivefireHttpError(
        `${slug}:${action}`,
        response.status,
        text,
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async rpc<T>(name: string, body: unknown): Promise<T> {
    const response = await fetch(
      new URL(`/rest/v1/rpc/${name}`, this.config.supabaseUrl),
      {
        method: "POST",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new LivefireHttpError(
        `RPC ${name}`,
        response.status,
        text,
      );
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  async sendFixture(
    fixture: SyntheticFixture,
  ): Promise<Record<string, unknown>> {
    return await this.action("send-outlook-email", "", {
      method: "POST",
      body: {
        from: "marnin@secureworkswa.com.au",
        to: ["ses@secureworkswa.com.au"],
        cc: [],
        bcc: [],
        subject: fixture.subject,
        htmlBody: fixture.htmlBody,
        sent_by: "ses_synthetic_livefire_lab",
        attachments: fixture.attachment
          ? [{
            name: fixture.attachment.name,
            contentType: fixture.attachment.contentType,
            contentBytes: encodeBase64(fixture.attachment.bytes),
          }]
          : [],
      },
    });
  }

  async rowsForIds<T>(
    table: string,
    column: string,
    ids: readonly string[],
    select = "*",
  ): Promise<T[]> {
    if (!ids.length) return [];
    return await this.rest<T[]>(table, {
      select,
      [column]: inFilter(ids),
    });
  }

  async deleteIds(
    table: string,
    column: string,
    ids: readonly string[],
  ): Promise<Record<string, unknown>[]> {
    if (!ids.length) return [];
    return await this.rest<Record<string, unknown>[]>(table, {
      select: "*",
      [column]: inFilter(ids),
    }, { method: "DELETE" });
  }

  async removeStorageObjects(
    bucket: string,
    paths: readonly string[],
  ): Promise<unknown> {
    if (!paths.length) return [];
    const response = await fetch(
      new URL(`/storage/v1/object/${bucket}`, this.config.supabaseUrl),
      {
        method: "DELETE",
        headers: this.headers({ "content-type": "application/json" }),
        body: JSON.stringify({ prefixes: paths }),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new LivefireHttpError(
        `storage:${bucket}:remove`,
        response.status,
        text,
      );
    }
    return text ? JSON.parse(text) : null;
  }
}
