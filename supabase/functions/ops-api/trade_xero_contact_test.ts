// Tests for trade supplier Xero contact resolution.
//
// No network. No live Supabase. No Xero.
// Mirrors resolveTradeXeroSupplierContact from index.ts so this bug stays
// locked: when a trade's Supabase email differs from the existing Xero
// supplier contact email, we must lookup by exact name before trying to
// create a duplicate Xero contact.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

function xeroContactWherePath(field: string, value: string): string {
  const escaped = String(value || "").replace(/\\/g, "\\\\").replace(
    /"/g,
    '\\"',
  );
  return "/Contacts?where=" + encodeURIComponent(`${field}=="${escaped}"`);
}

async function resolveTradeXeroSupplierContactForTest(
  client: any,
  args: {
    userId?: string | null;
    name?: string | null;
    email?: string | null;
    cachedContactId?: string | null;
    accessToken: string;
    tenantId: string;
  },
  deps: {
    xeroGet: (
      path: string,
      accessToken: string,
      tenantId: string,
    ) => Promise<any>;
    xeroPost: (
      path: string,
      accessToken: string,
      tenantId: string,
      body: any,
      method?: string,
    ) => Promise<any>;
  },
): Promise<string | null> {
  const cachedContactId = (args.cachedContactId || "").trim();
  if (cachedContactId) return cachedContactId;

  const tradeName = (args.name || "Trade").trim() || "Trade";
  const tradeEmail = (args.email || "").trim();
  let xeroContactId: string | null = null;

  if (tradeEmail) {
    try {
      const contacts = await deps.xeroGet(
        xeroContactWherePath("EmailAddress", tradeEmail),
        args.accessToken,
        args.tenantId,
      );
      if (contacts?.Contacts?.length > 0) {
        xeroContactId = contacts.Contacts[0].ContactID;
      }
    } catch { /* fallback to name lookup/create */ }
  }

  if (!xeroContactId && tradeName) {
    try {
      const contacts = await deps.xeroGet(
        xeroContactWherePath("Name", tradeName),
        args.accessToken,
        args.tenantId,
      );
      if (contacts?.Contacts?.length > 0) {
        xeroContactId = contacts.Contacts[0].ContactID;
      }
    } catch { /* fallback to create */ }
  }

  if (!xeroContactId) {
    const createRes = await deps.xeroPost(
      "/Contacts",
      args.accessToken,
      args.tenantId,
      {
        Contacts: [{
          Name: tradeName,
          EmailAddress: tradeEmail || undefined,
          IsSupplier: true,
        }],
      },
      "PUT",
    );
    xeroContactId = createRes?.Contacts?.[0]?.ContactID || null;
  }

  if (xeroContactId && args.userId) {
    await client.from("users").update({ xero_contact_id: xeroContactId }).eq(
      "id",
      args.userId,
    );
  }

  return xeroContactId;
}

function fakeClient() {
  const updates: any[] = [];
  return {
    updates,
    from(table: string) {
      return {
        update(values: any) {
          return {
            eq(column: string, value: any) {
              updates.push({ table, values, column, value });
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

Deno.test("trade Xero contact — cached ContactID short-circuits Xero lookup/create", async () => {
  const client = fakeClient();
  let calls = 0;
  const result = await resolveTradeXeroSupplierContactForTest(client, {
    userId: "user-jean",
    name: "Jean Crous",
    email: "jeancrous44@gmail.com",
    cachedContactId: "contact-cached",
    accessToken: "at",
    tenantId: "tenant",
  }, {
    xeroGet: async () => {
      calls++;
      throw new Error("should not lookup");
    },
    xeroPost: async () => {
      calls++;
      throw new Error("should not create");
    },
  });

  assertEquals(result, "contact-cached");
  assertEquals(calls, 0);
  assertEquals(client.updates.length, 0);
});

Deno.test("trade Xero contact — falls back from email miss to exact name match before create", async () => {
  const client = fakeClient();
  const paths: string[] = [];
  let createCalled = false;

  const result = await resolveTradeXeroSupplierContactForTest(client, {
    userId: "user-jean",
    name: "Jean Crous",
    email: "jeancrous44@gmail.com",
    accessToken: "at",
    tenantId: "tenant",
  }, {
    xeroGet: async (path: string) => {
      paths.push(path);
      if (decodeURIComponent(path).includes("EmailAddress==")) {
        return { Contacts: [] };
      }
      if (decodeURIComponent(path).includes('Name=="Jean Crous"')) {
        return { Contacts: [{ ContactID: "contact-jean-xero" }] };
      }
      return { Contacts: [] };
    },
    xeroPost: async () => {
      createCalled = true;
      throw new Error("duplicate contact create should be avoided");
    },
  });

  assertEquals(result, "contact-jean-xero");
  assertEquals(createCalled, false);
  assert(
    paths.some((p) =>
      decodeURIComponent(p).includes('EmailAddress=="jeancrous44@gmail.com"')
    ),
  );
  assert(
    paths.some((p) => decodeURIComponent(p).includes('Name=="Jean Crous"')),
  );
  assertEquals(client.updates, [{
    table: "users",
    values: { xero_contact_id: "contact-jean-xero" },
    column: "id",
    value: "user-jean",
  }]);
});

Deno.test("trade Xero contact — creates only after cached/email/name are absent", async () => {
  const client = fakeClient();
  const posts: any[] = [];

  const result = await resolveTradeXeroSupplierContactForTest(client, {
    userId: "user-new",
    name: "New Trade",
    email: "new@example.com",
    accessToken: "at",
    tenantId: "tenant",
  }, {
    xeroGet: async () => ({ Contacts: [] }),
    xeroPost: async (
      path: string,
      _at: string,
      _tenant: string,
      body: any,
      method?: string,
    ) => {
      posts.push({ path, body, method });
      return { Contacts: [{ ContactID: "contact-new" }] };
    },
  });

  assertEquals(result, "contact-new");
  assertEquals(posts.length, 1);
  assertEquals(posts[0].path, "/Contacts");
  assertEquals(posts[0].method, "PUT");
  assertEquals(posts[0].body.Contacts[0], {
    Name: "New Trade",
    EmailAddress: "new@example.com",
    IsSupplier: true,
  });
});
