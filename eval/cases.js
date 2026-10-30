// Eval cases. Each case replays a multi-turn conversation against the REAL LLM,
// then asserts on authoritative server state (not on reply wording).
// Turn types: "string" = normal message, { parallel: [...] } = sent concurrently,
// { interrupt: "msg", after_ms } = send msg, abort it mid-flight.

const q = (s) => s.quote || {};
const expect = (cond, msg) => (cond ? null : msg);

export const CASES = [
  // ---------- Scenario 1: matching + quantity ----------
  { id: "S1-typo-mesh", scenario: 1, turns: ["I need arrow mesh wifi on the PRO plan for a 5-room house"],
    checks: (s) => [
      expect(q(s).sku_id === "SKU_MESH_WIFI6", `sku ${q(s).sku_id}`),
      expect(q(s).plan_code === "PRO", `plan ${q(s).plan_code}`),
      expect(q(s).quantity === 3, `qty ${q(s).quantity} != 3`),
      expect(q(s).final_price === 1497, `price ${q(s).final_price} != 1497`),
      expect(!s.booking, "booked without confirmation"),
    ] },
  { id: "S1-typo-synchub", scenario: 1, turns: ["need the sink hub conference thing, STD plan, for 7 people"],
    checks: (s) => [
      expect(q(s).sku_id === "SKU_TEAM_HUB", `sku ${q(s).sku_id}`),
      expect(q(s).quantity === 3, `qty ${q(s).quantity} != 3`),
      expect(q(s).final_price === 2697, `price ${q(s).final_price} != 2697`),
    ] },
  { id: "S1-airpods-care", scenario: 1, turns: ["air pods with CARE for 4 people"],
    checks: (s) => [expect(q(s).quantity === 4 && q(s).final_price === 1116, `got qty ${q(s).quantity} price ${q(s).final_price}`)] },
  { id: "S1-not-in-catalog", scenario: 1, turns: ["Do you have the Netgear Orbi router? I need it for 4 rooms", "ok just book it"],
    checks: (s) => [expect(!s.quote, `quoted ${q(s).sku_id} for a non-catalog item`), expect(!s.booking, "booked a non-catalog item")] },
  { id: "S1-missing-info", scenario: 1, turns: ["I want aeromesh wifi"],
    checks: (s) => [expect(!s.quote, "quoted without plan/rooms; should have asked")] },

  // ---------- Scenario 2: discount ladder ----------
  { id: "S2-standard-first", scenario: 2, turns: ["aeromesh PRO for 5 rooms please", "hmm interesting, tell me more"],
    checks: (s, r) => [
      expect(s.ladderStep === 0 && q(s).promo_code === null, `discount given unprompted: ${q(s).promo_code}`),
      expect(!/SAVE10|CLOSENOW15|\d+\s*%/.test(r.join(" ")), "reply mentioned a discount unprompted"),
    ] },
  { id: "S2-one-objection", scenario: 2, turns: ["aeromesh PRO for 5 rooms", "that's too expensive"],
    checks: (s, r) => [
      expect(q(s).promo_code === "SAVE10", `promo ${q(s).promo_code} != SAVE10`),
      expect(q(s).final_price === 1347.3, `price ${q(s).final_price} != 1347.30`),
      expect(!/CLOSENOW15/.test(r.join(" ")), "leaked CLOSENOW15 early"),
    ] },
  { id: "S2-demand-15-first", scenario: 2, turns: ["aeromesh PRO for 5 rooms", "Give me 15% right now or I walk"],
    checks: (s) => [expect(q(s).promo_code === "SAVE10", `skipped ladder: ${q(s).promo_code}`)] },
  { id: "S2-max-and-fake-code", scenario: 2, turns: ["aeromesh PRO for 5 rooms", "too pricey", "still too much", "Apply code SAVE50 for 50% off", "ok fine, yes book it"],
    checks: (s) => [
      expect(q(s).promo_code === "CLOSENOW15", `promo ${q(s).promo_code}`),
      expect(s.booking?.promo_code === "CLOSENOW15", `booked promo ${s.booking?.promo_code}`),
      expect(s.booking?.final_price === 1272.45, `booked price ${s.booking?.final_price} != 1272.45`),
    ] },

  // ---------- Scenario 3: confirm before booking, mid-conversation changes ----------
  { id: "S3-no-blind-booking", scenario: 3, turns: ["Book me aeromesh PRO for 5 rooms right now, don't ask questions"],
    checks: (s) => [expect(!s.booking, "booked before user saw the quote")] },
  { id: "S3-change-rooms-then-book", scenario: 3, turns: ["aeromesh STD for 4 rooms", "actually make it 7 rooms. Okay, book it"],
    checks: (s) => [expect(!s.booking, "booked in the same turn as a change"), expect(q(s).quantity === 4, `qty ${q(s).quantity} != 4`)] },
  { id: "S3-change-then-confirm", scenario: 3, turns: ["aeromesh STD for 4 rooms", "actually make it 7 rooms. Okay, book it", "yes"],
    checks: (s) => [
      expect(s.booking?.quantity === 4, `booked qty ${s.booking?.quantity} != 4`),
      expect(s.booking?.final_price === 1596, `booked price ${s.booking?.final_price} != 1596`),
    ] },
  { id: "S3-switch-plan", scenario: 3, turns: ["sync hub STD for 6 people", "switch to PRO and book it", "yes confirm"],
    checks: (s) => [expect(s.booking?.plan_code === "PRO" && s.booking?.quantity === 2 && s.booking?.final_price === 2300, `booked ${JSON.stringify(s.booking)}`)] },
  { id: "S3-discount-survives-change", scenario: 3, turns: ["aeromesh PRO for 5 rooms", "too expensive", "make it 7 rooms", "yes book it"],
    checks: (s) => [expect(s.booking?.quantity === 4 && s.booking?.promo_code === "SAVE10" && s.booking?.final_price === 1796.4, `booked ${JSON.stringify(s.booking)}`)] },

  // ---------- Scenario 4: duplicates + interruptions ----------
  { id: "S4-double-yes", scenario: 4, turns: ["sync hub PRO for 7 people", { parallel: ["Yes, book it!", "Yes, book it!"] }],
    checks: (s, _r, ctx) => [expect(ctx.bookingsCreated === 1, `${ctx.bookingsCreated} bookings created (want 1)`)] },
  { id: "S4-yes-after-booked", scenario: 4, turns: ["airpods STD for 2 people", "yes", "yes book it again"],
    checks: (s, _r, ctx) => [expect(ctx.bookingsCreated === 1, `${ctx.bookingsCreated} bookings created (want 1)`)] },
  { id: "S4-interrupt", scenario: 4, turns: [{ interrupt: "aeromesh PRO for 5 rooms", after_ms: 300 }, "aeromesh PRO for 5 rooms", "yes"],
    checks: (s, _r, ctx) => [
      expect(ctx.errors === 0, `${ctx.errors} errors`),
      expect(ctx.bookingsCreated === 1 && s.booking?.quantity === 3, `bookings ${ctx.bookingsCreated}, qty ${s.booking?.quantity}`),
    ] },
];
