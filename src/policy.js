// Deterministic business rules. The LLM never computes quantity, price or discount.
import { CATALOG } from "./catalog.js";

export const DISCOUNT_LADDER = [
  { promo_code: null, pct: 0 },
  { promo_code: "SAVE10", pct: 10 },
  { promo_code: "CLOSENOW15", pct: 15 }, // absolute maximum
];

export function quantityFor(sku_id, requirement) {
  const cap = CATALOG[sku_id].max_capacity_per_unit;
  if (!Number.isInteger(requirement) || requirement < 1) throw new Error("requirement must be a positive integer");
  return Math.ceil(requirement / cap);
}

export const round2 = (n) => Math.round(n * 100) / 100;

export function buildQuote(sku_id, plan_code, requirement, ladderStep) {
  const item = CATALOG[sku_id];
  if (!item) throw new Error(`Unknown sku ${sku_id}`);
  const unit_price = item.plans[plan_code];
  if (unit_price === undefined) throw new Error(`Plan ${plan_code} not available for ${item.name}. Valid: ${Object.keys(item.plans).join(", ")}`);
  const quantity = quantityFor(sku_id, requirement);
  const { promo_code, pct } = DISCOUNT_LADDER[ladderStep];
  const subtotal = round2(unit_price * quantity);
  const final_price = round2(subtotal * (1 - pct / 100));
  return {
    sku_id, product_name: item.name, plan_code, requirement,
    capacity_per_unit: item.max_capacity_per_unit, quantity, unit_price,
    subtotal, promo_code, discount_pct: pct, final_price,
  };
}

export const quoteKey = (q) => [q.sku_id, q.plan_code, q.quantity, q.promo_code ?? "NONE", q.final_price].join("|");
