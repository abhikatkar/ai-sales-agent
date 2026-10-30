// Per-conversation state + guarded tool handlers. This is the "source of truth";
// the LLM only proposes actions, the server decides if they are legal.
import { get_catalog_info, create_booking_api, CATALOG } from "./catalog.js";
import { buildQuote, quoteKey, DISCOUNT_LADDER } from "./policy.js";

const sessions = new Map();
const inflightBookings = new Map(); // idempotencyKey -> Promise<booking>

const AFFIRMATIVE = /\b(yes|yeah|yep|yup|sure|ok|okay|confirm(ed)?|go ahead|book( it)?|place (the )?order|deal|proceed|do it|sounds good|let'?s do it)\b/i;

export function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      history: [],            // committed Anthropic messages only
      catalogFetched: false,
      selection: null,        // { sku_id, plan_code, requirement }
      ladderStep: 0,          // 0 -> standard, 1 -> SAVE10, 2 -> CLOSENOW15
      quote: null,            // current server-computed quote
      quoteVersion: 0,        // bumps on ANY change to selection/discount
      presentedVersion: -1,   // version the user has actually SEEN in a reply
      booking: null,
      events: [],             // audit log of every API call + guard decision
      queue: Promise.resolve(),
      currentAbort: null,
    });
  }
  return sessions.get(id);
}

export function log(s, type, data) {
  const e = { ts: new Date().toISOString(), type, ...data };
  s.events.push(e);
  return e;
}

function refreshQuote(s) {
  const { sku_id, plan_code, requirement } = s.selection;
  s.quote = buildQuote(sku_id, plan_code, requirement, s.ladderStep);
  s.quoteVersion++;
  s.quote.quote_version = s.quoteVersion;
}

/** Tool handlers. `turn` = { userText, objectionUsed, versionAtTurnStart } */
export const handlers = {
  get_catalog_info(s, { query }) {
    const res = get_catalog_info(query);
    s.catalogFetched = true;
    log(s, "API_CALL", { api: "GET /api/catalog", payload: { query }, response: res });
    return res;
  },

  set_order(s, { sku_id, plan_code, requirement }, turn) {
    if (!s.catalogFetched) return { error: "Call get_catalog_info first." };
    if (!CATALOG[sku_id]) return { error: `Unknown sku_id ${sku_id}. Only catalog SKUs can be quoted.` };
    if (s.booking) return { error: `Order already booked (${s.booking.booking_id}). Start a new chat for a new order.` };
    try {
      s.selection = { sku_id, plan_code, requirement: Number(requirement) };
      refreshQuote(s);
    } catch (e) {
      return { error: e.message };
    }
    log(s, "QUOTE", { quote: s.quote });
    return { quote: s.quote, instruction: "Present product, plan, quantity (explain the capacity math), discount and final_price to the user, then ask them to confirm." };
  },

  register_price_objection(s, _args, turn) {
    if (!s.quote) return { error: "No quote yet." };
    if (turn.objectionUsed) return { error: "Objection already registered this turn.", quote: s.quote };
    turn.objectionUsed = true;
    if (s.ladderStep >= DISCOUNT_LADDER.length - 1) {
      log(s, "GUARD", { rule: "max_discount", note: "Already at CLOSENOW15; no further discount." });
      return { quote: s.quote, note: "Maximum discount already applied. Do not offer anything more." };
    }
    s.ladderStep++;
    refreshQuote(s);
    log(s, "DISCOUNT_STEP", { step: s.ladderStep, promo_code: s.quote.promo_code });
    return { quote: s.quote, instruction: `Offer ${s.quote.promo_code} (${s.quote.discount_pct}% off). New total ${s.quote.final_price}. Ask to confirm.` };
  },

  async create_booking(s, { quote_version }, turn) {
    const deny = (reason) => { log(s, "GUARD", { rule: "booking_blocked", reason }); return { booked: false, reason }; };

    if (s.booking) {
      log(s, "GUARD", { rule: "idempotent", reason: "Duplicate confirmation; returning existing booking." });
      return { booked: true, duplicate_prevented: true, booking: s.booking };
    }
    if (!s.quote) return deny("No quote exists.");
    if (quote_version !== s.quoteVersion) return deny(`Stale quote_version ${quote_version}; current is ${s.quoteVersion}. Present the current quote and get confirmation.`);
    if (s.quoteVersion !== turn.versionAtTurnStart) return deny("Details or price changed in this turn. Present the updated quote and ask the user to confirm before booking.");
    if (s.presentedVersion !== s.quoteVersion) return deny("The user has not yet been shown this exact quote. Present it and ask to confirm.");
    if (!AFFIRMATIVE.test(turn.userText)) return deny("User's latest message is not an explicit confirmation.");

    const q = s.quote;
    const payload = { sku_id: q.sku_id, plan_code: q.plan_code, quantity: q.quantity, promo_code: q.promo_code, final_price: q.final_price };
    const key = `${s.id}|${quoteKey(q)}`;
    if (!inflightBookings.has(key)) {
      log(s, "API_CALL", { api: "POST /api/bookings", payload, idempotency_key: key });
      inflightBookings.set(key, create_booking_api(payload));
    }
    const booking = await inflightBookings.get(key); // concurrent duplicates share one call
    s.booking = booking;
    log(s, "API_RESPONSE", { api: "POST /api/bookings", response: booking });
    return { booked: true, booking };
  },
};

export { AFFIRMATIVE };
