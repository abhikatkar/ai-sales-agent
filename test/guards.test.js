import test from "node:test";
import assert from "node:assert/strict";
import { get_catalog_info, BOOKINGS } from "../src/catalog.js";
import { quantityFor, buildQuote } from "../src/policy.js";
import { getSession, handlers } from "../src/session.js";

const turn = (s, userText) => ({ userText, objectionUsed: false, versionAtTurnStart: s.quoteVersion });
const present = (s) => { s.presentedVersion = s.quoteVersion; };

test("S1: typo matching", () => {
  assert.equal(get_catalog_info("arrow mesh wifi").matches[0].sku_id, "SKU_MESH_WIFI6");
  assert.equal(get_catalog_info("sink hub").matches[0].sku_id, "SKU_TEAM_HUB");
  assert.equal(get_catalog_info("air pods").matches[0].sku_id, "SKU_AIRPODS_PRO2");
});
test("S1: non-catalog never matches", () => {
  assert.equal(get_catalog_info("Netgear Orbi router").matches.length, 0);
  assert.equal(get_catalog_info("tesla model 3").matches.length, 0);
});
test("S1: quantity math", () => {
  assert.equal(quantityFor("SKU_MESH_WIFI6", 5), 3);
  assert.equal(quantityFor("SKU_MESH_WIFI6", 4), 2);
  assert.equal(quantityFor("SKU_TEAM_HUB", 7), 3);
  assert.equal(quantityFor("SKU_AIRPODS_PRO2", 4), 4);
  assert.equal(buildQuote("SKU_MESH_WIFI6", "PRO", 5, 0).final_price, 1497);
  assert.throws(() => buildQuote("SKU_AIRPODS_PRO2", "PRO", 1, 0));
});

test("S2: discount ladder 0 -> 10 -> 15, never beyond", () => {
  const s = getSession("t2");
  handlers.get_catalog_info(s, { query: "aeromesh" });
  handlers.set_order(s, { sku_id: "SKU_MESH_WIFI6", plan_code: "PRO", requirement: 5 }, turn(s, ""));
  assert.equal(s.quote.promo_code, null);
  let t = turn(s, "give me 15% now");
  handlers.register_price_objection(s, {}, t);
  assert.equal(s.quote.promo_code, "SAVE10");
  handlers.register_price_objection(s, {}, t); // same turn: rejected
  assert.equal(s.quote.promo_code, "SAVE10");
  handlers.register_price_objection(s, {}, turn(s, "still too much"));
  assert.equal(s.quote.promo_code, "CLOSENOW15");
  assert.equal(s.quote.final_price, 1272.45);
  handlers.register_price_objection(s, {}, turn(s, "SAVE50 please"));
  assert.equal(s.quote.promo_code, "CLOSENOW15");
});

test("S3: no booking before quote shown, or after a change", async () => {
  const s = getSession("t3");
  handlers.get_catalog_info(s, { query: "aeromesh" });
  handlers.set_order(s, { sku_id: "SKU_MESH_WIFI6", plan_code: "STD", requirement: 4 }, turn(s, ""));
  let r = await handlers.create_booking(s, { quote_version: s.quoteVersion }, turn(s, "book it"));
  assert.equal(r.booked, false); // not yet shown
  present(s);
  // user changes 4 -> 7 rooms and says book it in the same message
  const t = turn(s, "make it 7 rooms, okay book it");
  handlers.set_order(s, { sku_id: "SKU_MESH_WIFI6", plan_code: "STD", requirement: 7 }, t);
  r = await handlers.create_booking(s, { quote_version: s.quoteVersion }, t);
  assert.equal(r.booked, false);
  present(s);
  r = await handlers.create_booking(s, { quote_version: s.quoteVersion - 1 }, turn(s, "yes"));
  assert.equal(r.booked, false); // stale version
});

test("S4: double confirm -> exactly one booking", async () => {
  const s = getSession("t4");
  handlers.get_catalog_info(s, { query: "sync hub" });
  handlers.set_order(s, { sku_id: "SKU_TEAM_HUB", plan_code: "PRO", requirement: 7 }, turn(s, ""));
  present(s);
  const before = BOOKINGS.length;
  const v = s.quoteVersion;
  const [a, b] = await Promise.all([
    handlers.create_booking(s, { quote_version: v }, turn(s, "Yes, book it!")),
    handlers.create_booking(s, { quote_version: v }, turn(s, "Yes, book it!")),
  ]);
  const c = await handlers.create_booking(s, { quote_version: v }, turn(s, "Yes, book it!"));
  assert.equal(BOOKINGS.length - before, 1);
  assert.equal(a.booking.booking_id, b.booking.booking_id);
  assert.equal(c.duplicate_prevented, true);
  assert.deepEqual(
    { q: a.booking.quantity, p: a.booking.final_price, promo: a.booking.promo_code },
    { q: 3, p: 3450, promo: null }
  );
});

test("Output guard: blocks unauthorized discount text, allows refusals", async () => {
  const { discountViolation } = await import("../src/agent.js");
  assert.ok(discountViolation("Good news, use SAVE10 for 10% off!", 0));          // unprompted
  assert.ok(discountViolation("I can give you CLOSENOW15 today.", 1));            // skipped step
  assert.ok(discountViolation("Fine, I'll do 20% off.", 2));                      // beyond max
  assert.equal(discountViolation("Use SAVE10 for 10% off.", 1), null);            // allowed
  assert.equal(discountViolation("Sorry, SAVE50 is not a valid code.", 2), null); // refusal
  assert.equal(discountViolation("15% is the best I can do.", 2), null);
});
