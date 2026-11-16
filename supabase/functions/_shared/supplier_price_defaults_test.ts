// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isSupplierPricedDefault,
  NON_SUPPLIER_PRICED_CATEGORY_FILTER,
} from "./supplier_price_defaults.ts";

Deno.test("staff_only, surcharge and panel-width rows are never compared with a supplier price", () => {
  assertEquals(
    NON_SUPPLIER_PRICED_CATEGORY_FILTER,
    '("fencing_surcharge","fencing_panels","staff_only")',
  );
  assertEquals(isSupplierPricedDefault({ category: "staff_only" }), false);
  assertEquals(isSupplierPricedDefault({ category: "fencing_surcharge" }), false);
  assertEquals(isSupplierPricedDefault({ category: "fencing_panels" }), false);
  assertEquals(isSupplierPricedDefault(null), false);
  assertEquals(isSupplierPricedDefault({ category: "fencing_posts" }), true);
  assertEquals(isSupplierPricedDefault({ category: "roofing" }), true);
  assertEquals(isSupplierPricedDefault({ category: null }), true);
});

// ops-ai's check_supplier_pricing has no test hook (its module starts a server
// on import), so its use of the shared rule is pinned at source: the query
// filter and the per-row skip. The daily digest is driven end to end in
// daily-digest/staff_only_price_drift_test.ts.
Deno.test("both supplier price readers use the shared rule in their read and their comparison", async () => {
  for (const path of ["../ops-ai/index.ts", "../daily-digest/index.ts"]) {
    const source = await Deno.readTextFile(new URL(path, import.meta.url));
    assert(
      source.includes("from '../_shared/supplier_price_defaults.ts'"),
      `${path} must import the shared rule`,
    );
    assert(
      source.includes(".not('category', 'in', NON_SUPPLIER_PRICED_CATEGORY_FILTER)"),
      `${path} must leave non-priced rows out of its read`,
    );
    assert(
      source.includes("if (!isSupplierPricedDefault(def)) continue"),
      `${path} must skip non-priced rows when comparing`,
    );
    assert(
      !source.includes('\'("fencing_surcharge","fencing_panels")\''),
      `${path} must not keep its own category list`,
    );
  }
});
