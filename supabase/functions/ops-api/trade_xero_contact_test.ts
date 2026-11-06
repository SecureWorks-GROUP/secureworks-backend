// deno-lint-ignore-file no-explicit-any no-import-prefix require-await
// Trade supplier Xero contact resolution.
//
// No network. No live Supabase. No Xero. Drives the real resolver in
// trade_xero_contact.ts. A mirrored copy of this function is how the
// work-order path kept creating a second contact after the other pushes
// had learned to look the name up first.

import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { XeroCooldownError } from "../_shared/xero_cooldown.ts";
import {
  chooseTradeSupplierContact,
  resolveTradeXeroSupplierContact,
  type TradeXeroSupplierContactArgs,
} from "./trade_xero_contact.ts";

const INDEX_SRC = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

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

function args(
  over: Partial<TradeXeroSupplierContactArgs> = {},
): TradeXeroSupplierContactArgs {
  return {
    userId: "user-jean",
    name: "Jean Crous",
    email: "jeancrous44@gmail.com",
    accessToken: "at",
    tenantId: "tenant",
    ...over,
  };
}

function decoded(path: string): string {
  return decodeURIComponent(path);
}

Deno.test("trade Xero contact — a live cached ContactID is re-read and not recreated", async () => {
  const client = fakeClient();
  const paths: string[] = [];
  const result = await resolveTradeXeroSupplierContact(
    client,
    args({
      cachedContactId: "contact-cached",
    }),
    {
      xeroGet: async (path: string) => {
        paths.push(path);
        return {
          Contacts: [{
            ContactID: "contact-cached",
            Name: "Jean Crous",
            ContactStatus: "ACTIVE",
          }],
        };
      },
      xeroPost: async () => {
        throw new Error("should not write");
      },
    },
  );

  assertEquals(result, "contact-cached");
  assertEquals(paths, ["/Contacts/contact-cached"]);
  assertEquals(client.updates.length, 0);
});

Deno.test("trade Xero contact — an archived cached contact is restored, not replaced", async () => {
  const client = fakeClient();
  const posts: any[] = [];
  const result = await resolveTradeXeroSupplierContact(
    client,
    args({
      cachedContactId: "contact-archived",
    }),
    {
      xeroGet: async () => ({
        Contacts: [{
          ContactID: "contact-archived",
          Name: "Jean Crous",
          ContactStatus: "ARCHIVED",
        }],
      }),
      xeroPost: async (
        path: string,
        _at: string,
        _tenant: string,
        body: any,
        method?: string,
      ) => {
        posts.push({ path, body, method });
        return {
          Contacts: [{
            ContactID: "contact-archived",
            ContactStatus: "ACTIVE",
          }],
        };
      },
    },
  );

  assertEquals(result, "contact-archived");
  assertEquals(posts, [{
    path: "/Contacts",
    method: "POST",
    body: {
      Contacts: [{ ContactID: "contact-archived", ContactStatus: "ACTIVE" }],
    },
  }]);
  assertEquals(client.updates.length, 0);
});

Deno.test("trade Xero contact — a Xero cooldown on the cached read is not swallowed", async () => {
  const client = fakeClient();
  const cooldown = new XeroCooldownError("cooling", 429, "XERO_COOLDOWN");
  await assertRejects(
    () =>
      resolveTradeXeroSupplierContact(
        client,
        args({
          cachedContactId: "contact-cached",
        }),
        {
          xeroGet: async () => {
            throw cooldown;
          },
          xeroPost: async () => {
            throw new Error("should not write");
          },
        },
      ),
    XeroCooldownError,
    "cooling",
  );
  assertEquals(client.updates.length, 0);
});

Deno.test("trade Xero contact — email miss falls through to the exact name before create", async () => {
  const client = fakeClient();
  const paths: string[] = [];
  let createCalled = false;

  const result = await resolveTradeXeroSupplierContact(client, args(), {
    xeroGet: async (path: string) => {
      paths.push(path);
      if (decoded(path).includes("EmailAddress==")) return { Contacts: [] };
      if (decoded(path).includes('Name=="Jean Crous"')) {
        return {
          Contacts: [{
            ContactID: "contact-jean-xero",
            Name: "Jean Crous",
            ContactStatus: "ACTIVE",
            EmailAddress: "jeancrous@gmail.com",
          }],
        };
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
    paths.some((path) =>
      decoded(path).includes('EmailAddress=="jeancrous44@gmail.com"')
    ),
  );
  assert(paths.some((path) => decoded(path).includes('Name=="Jean Crous"')));
  assertEquals(client.updates, [{
    table: "users",
    values: { xero_contact_id: "contact-jean-xero" },
    column: "id",
    value: "user-jean",
  }]);
});

Deno.test("trade Xero contact — an email hit on a customer who is not this trade is not billed", async () => {
  const client = fakeClient();
  const posts: any[] = [];
  const result = await resolveTradeXeroSupplierContact(client, args(), {
    xeroGet: async (path: string) => {
      if (decoded(path).includes("EmailAddress==")) {
        return {
          Contacts: [{
            ContactID: "contact-customer",
            Name: "Home Owner",
            ContactStatus: "ACTIVE",
            IsCustomer: true,
            IsSupplier: false,
          }],
        };
      }
      if (decoded(path).includes('Name=="Jean Crous"')) {
        return {
          Contacts: [{
            ContactID: "contact-jean-xero",
            Name: "Jean Crous",
            ContactStatus: "ACTIVE",
            IsSupplier: true,
          }],
        };
      }
      return { Contacts: [] };
    },
    xeroPost: async () => {
      posts.push("create");
      throw new Error("should use the named supplier");
    },
  });

  assertEquals(result, "contact-jean-xero");
  assertEquals(posts, []);
});

Deno.test("trade Xero contact — several email hits are not guessed when none is this trade", async () => {
  const client = fakeClient();
  const result = await resolveTradeXeroSupplierContact(
    client,
    args({
      name: "New Trade",
      email: "shared@example.com",
      userId: "user-new",
    }),
    {
      xeroGet: async (path: string) => {
        if (decoded(path).includes("EmailAddress==")) {
          return {
            Contacts: [
              {
                ContactID: "contact-a",
                Name: "Supplier A",
                ContactStatus: "ACTIVE",
                IsSupplier: true,
              },
              {
                ContactID: "contact-b",
                Name: "Supplier B",
                ContactStatus: "ACTIVE",
                IsSupplier: true,
              },
            ],
          };
        }
        return { Contacts: [] };
      },
      xeroPost: async (
        _path: string,
        _at: string,
        _tenant: string,
        body: any,
        method?: string,
      ) => {
        assertEquals(method, "PUT");
        assertEquals(body.Contacts[0].Name, "New Trade");
        return { Contacts: [{ ContactID: "contact-new" }] };
      },
    },
  );

  assertEquals(result, "contact-new");
  assertEquals(client.updates[0].values, { xero_contact_id: "contact-new" });
});

Deno.test("trade Xero contact — one supplier among several email hits is that supplier", async () => {
  const client = fakeClient();
  const result = await resolveTradeXeroSupplierContact(client, args(), {
    xeroGet: async (path: string) => {
      if (!decoded(path).includes("EmailAddress==")) return { Contacts: [] };
      return {
        Contacts: [
          {
            ContactID: "contact-customer",
            Name: "Home Owner",
            ContactStatus: "ACTIVE",
            IsCustomer: true,
          },
          {
            ContactID: "contact-jean-xero",
            Name: "JC Fencing",
            ContactStatus: "ACTIVE",
            IsSupplier: true,
          },
        ],
      };
    },
    xeroPost: async () => {
      throw new Error("should not create");
    },
  });

  assertEquals(result, "contact-jean-xero");
});

Deno.test("trade Xero contact — the same person found by email is used even as a customer", async () => {
  const client = fakeClient();
  const result = await resolveTradeXeroSupplierContact(client, args(), {
    xeroGet: async () => ({
      Contacts: [{
        ContactID: "contact-jean-xero",
        Name: "Jean Crous",
        ContactStatus: "ACTIVE",
        IsCustomer: true,
        IsSupplier: false,
      }],
    }),
    xeroPost: async () => {
      throw new Error("should not create a second Jean Crous");
    },
  });

  assertEquals(result, "contact-jean-xero");
});

Deno.test("trade Xero contact — an archived name match is restored before create", async () => {
  const client = fakeClient();
  const posts: any[] = [];
  const result = await resolveTradeXeroSupplierContact(client, args(), {
    xeroGet: async (path: string) => {
      if (decoded(path).includes("EmailAddress==")) return { Contacts: [] };
      return {
        Contacts: [{
          ContactID: "contact-jean-xero",
          Name: "Jean Crous",
          ContactStatus: "ARCHIVED",
        }],
      };
    },
    xeroPost: async (
      path: string,
      _at: string,
      _tenant: string,
      body: any,
      method?: string,
    ) => {
      posts.push({ path, method, body });
      return {};
    },
  });

  assertEquals(result, "contact-jean-xero");
  assertEquals(posts.length, 1);
  assertEquals(posts[0].method, "POST");
  assertEquals(posts[0].body.Contacts[0].ContactStatus, "ACTIVE");
});

Deno.test("trade Xero contact — creates only after cached, email and name are absent", async () => {
  const client = fakeClient();
  const posts: any[] = [];
  const result = await resolveTradeXeroSupplierContact(
    client,
    args({
      userId: "user-new",
      name: "New Trade",
      email: "new@example.com",
    }),
    {
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
    },
  );

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

Deno.test("trade Xero contact — a duplicate-name refusal reads the existing contact instead of failing", async () => {
  const client = fakeClient();
  const paths: string[] = [];
  let creates = 0;
  const duplicate = new Error(
    "Xero validation error: The contact name already exists. Contact names must be unique.",
  );

  const result = await resolveTradeXeroSupplierContact(client, args(), {
    xeroGet: async (path: string) => {
      paths.push(path);
      const query = decoded(path);
      if (query.includes("EmailAddress==")) return { Contacts: [] };
      if (
        query.includes('Name=="Jean Crous"') &&
        paths.filter((p) => decoded(p).includes('Name=="Jean Crous"'))
            .length === 1
      ) {
        return { Contacts: [] };
      }
      if (query.includes('Name=="Jean Crous"')) {
        return {
          Contacts: [{
            ContactID: "contact-jean-xero",
            Name: "Jean Crous",
            ContactStatus: "ACTIVE",
            IsSupplier: true,
          }],
        };
      }
      return { Contacts: [] };
    },
    xeroPost: async () => {
      creates++;
      throw duplicate;
    },
  });

  assertEquals(result, "contact-jean-xero");
  assertEquals(creates, 1);
  assertEquals(
    paths.filter((path) => decoded(path).includes('Name=="Jean Crous"')).length,
    2,
  );
});

Deno.test("trade Xero contact — a case-different existing name is found after the unique-name refusal", async () => {
  const client = fakeClient();
  const paths: string[] = [];
  const result = await resolveTradeXeroSupplierContact(client, args(), {
    xeroGet: async (path: string) => {
      paths.push(path);
      const query = decoded(path);
      if (query.includes('Name.ToLower()=="jean crous"')) {
        return {
          Contacts: [{
            ContactID: "contact-jean-xero",
            Name: "JEAN CROUS",
            ContactStatus: "ACTIVE",
            IsSupplier: true,
          }],
        };
      }
      return { Contacts: [] };
    },
    xeroPost: async () => {
      throw new Error(
        "Xero validation error: The contact name already exists. Contact names must be unique.",
      );
    },
  });

  assertEquals(result, "contact-jean-xero");
  assert(
    paths.some((path) =>
      decoded(path).includes("Name!=null AND Name.ToLower()")
    ),
  );
});

Deno.test("trade Xero contact — a validation error that is not a duplicate name still fails", async () => {
  const client = fakeClient();
  await assertRejects(
    () =>
      resolveTradeXeroSupplierContact(
        client,
        args({
          name: "New Trade",
          email: "not-an-email",
          userId: "user-new",
        }),
        {
          xeroGet: async () => ({ Contacts: [] }),
          xeroPost: async () => {
            throw new Error(
              "Xero validation error: Email address must be valid",
            );
          },
        },
      ),
    Error,
    "Email address must be valid",
  );
  assertEquals(client.updates.length, 0);
});

Deno.test("trade Xero contact — a cooldown during email lookup is not turned into a create", async () => {
  const client = fakeClient();
  let created = false;
  await assertRejects(
    () =>
      resolveTradeXeroSupplierContact(client, args(), {
        xeroGet: async () => {
          throw new XeroCooldownError("cooling", 429, "XERO_COOLDOWN");
        },
        xeroPost: async () => {
          created = true;
          return { Contacts: [{ ContactID: "nope" }] };
        },
      }),
    XeroCooldownError,
    "cooling",
  );
  assertEquals(created, false);
});

Deno.test("chooseTradeSupplierContact prefers this trade's name over the first row", () => {
  const chosen = chooseTradeSupplierContact([
    {
      ContactID: "first",
      Name: "Someone Else",
      ContactStatus: "ACTIVE",
      IsSupplier: true,
    },
    {
      ContactID: "jean",
      Name: "Jean  Crous",
      ContactStatus: "ACTIVE",
      IsSupplier: true,
    },
  ], "jean crous");
  assertEquals(chosen?.ContactID, "jean");
});

Deno.test("a work-order invoice uses the shared supplier resolver and does not create a contact itself", () => {
  const start = INDEX_SRC.indexOf("case 'submit_work_order_invoice': {");
  assert(start > 0, "submit_work_order_invoice case missing");
  const next = INDEX_SRC.indexOf("\n          case '", start + 40);
  const block = INDEX_SRC.slice(start, next > start ? next : start + 12000);
  assert(
    block.includes("resolveTradeXeroSupplierContact("),
    "work-order invoice must resolve the supplier through the shared resolver",
  );
  assert(
    !block.includes("xeroPost('/Contacts'") &&
      !block.includes('xeroPost("/Contacts"'),
    "work-order invoice must not write /Contacts on its own",
  );
  assert(
    !INDEX_SRC.includes("EmailAddress%3D%3D"),
    "the old pre-encoded email lookup must not come back",
  );
});
