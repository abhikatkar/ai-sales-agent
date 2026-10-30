import { readFileSync } from "node:fs";
import { chat } from "./llm.js";
import { handlers, log } from "./session.js";
import { DISCOUNT_LADDER } from "./policy.js";


const SYSTEM = readFileSync(new URL("../prompts/system_prompt.md", import.meta.url), "utf8");

const TOOLS = [
  { name: "get_catalog_info", description: "GET /api/catalog. Search catalog by product name (typos ok). Empty query lists all.", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "set_order", description: "Set/replace the product, plan and user requirement (rooms/people/units). Server computes quantity and price and returns the authoritative quote.", parameters: { type: "object", properties: { sku_id: { type: "string" }, plan_code: { type: "string" }, requirement: { type: "integer", minimum: 1 } }, required: ["sku_id", "plan_code", "requirement"] } },
  { name: "register_price_objection", description: "Call ONLY when the user pushes back on price. Server applies the next allowed discount step and returns the updated quote.", parameters: { type: "object", properties: {} } },
  { name: "create_booking", description: "POST /api/bookings for the current quote. Pass the quote_version the user confirmed. Payload is built by the server from the quote.", parameters: { type: "object", properties: { quote_version: { type: "integer" } }, required: ["quote_version"] } },
];

// Output guardrail: catches the LLM *offering* a discount the server hasn't unlocked.
// Sentences that refuse ("can't", "invalid", "not") are allowed so polite refusals pass.
const NEGATION = /\b(not|no|can'?t|cannot|unable|invalid|isn'?t|won'?t|don'?t|doesn'?t|only|maximum|max|best I can)\b/i;
export function discountViolation(text, ladderStep) {
  const allowedPct = DISCOUNT_LADDER[ladderStep].pct;
  const allowedCodes = DISCOUNT_LADDER.slice(1, ladderStep + 1).map((d) => d.promo_code);
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    if (NEGATION.test(sentence)) continue;
    for (const d of DISCOUNT_LADDER.slice(1))
      if (sentence.includes(d.promo_code) && !allowedCodes.includes(d.promo_code)) return `offered ${d.promo_code} before it was unlocked`;
    for (const m of sentence.matchAll(/(\d{1,3})\s*%/g))
      if (Number(m[1]) > allowedPct) return `offered ${m[1]}% but max allowed now is ${allowedPct}%`;
  }
  return null;
}

function quoteCard(q) {
  const disc = q.promo_code ? ` | ${q.promo_code} (-${q.discount_pct}%)` : "";
  return `\n\n**Quote v${q.quote_version}:** ${q.product_name}, ${q.plan_code} plan, ${q.quantity} unit(s) for ${q.requirement} (covers ${q.capacity_per_unit}/unit) @ $${q.unit_price} = $${q.subtotal}${disc} → **Total $${q.final_price.toFixed(2)}**. Reply "yes" to confirm.`;
}

export async function runTurn(s, userText, signal) {
  const turn = { userText, objectionUsed: false, versionAtTurnStart: s.quoteVersion };
  const msgs = [...s.history, { role: "user", content: userText }]; // working copy; committed only on success
  log(s, "USER", { text: userText });

  let text = "";
  let retried = false;
  for (let i = 0; i < 8; i++) {
    const state = { catalog_fetched: s.catalogFetched, current_quote: s.quote, quote_shown_to_user: s.presentedVersion === s.quoteVersion, discount_step: s.ladderStep, booking: s.booking };
    const system = `${SYSTEM}\n\nSERVER STATE (authoritative):\n${JSON.stringify(state)}`;
    const res = await chat({ messages: [{ role: "system", content: system }, ...msgs], tools: TOOLS, signal });
    msgs.push({ role: "assistant", content: res.text || null, ...(res.toolCalls.length && { tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) }, ...(c.extra && { extra_content: c.extra }) })) }) });
    const calls = res.toolCalls;
    text = res.text;

    if (!calls.length) {
      const v = discountViolation(text, s.ladderStep);
      if (v && !retried) {
        retried = true;
        log(s, "GUARD", { rule: "unauthorized_discount_text", reason: v });
        msgs.push({ role: "user", content: `[SYSTEM GUARD] Your reply ${v}. Rewrite it without offering any discount beyond what the server has unlocked.` });
        continue;
      }
      if (v) text = "Here's the current price for your order."; // deterministic fallback
      break;
    }
    for (const c of calls) {
      const out = handlers[c.name] ? await handlers[c.name](s, c.args, turn) : { error: "unknown tool" };
      log(s, "TOOL", { name: c.name, input: c.args, output: out });
      msgs.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify(out) });
    }
  }

  // Deterministic quote card: whatever the LLM wrote, the user always sees the exact server numbers.
  if (s.quote && !s.booking && s.presentedVersion !== s.quoteVersion) {
    text += quoteCard(s.quote);
    s.presentedVersion = s.quoteVersion;
  }
  if (s.booking && !text.includes(s.booking.booking_id)) text += `\n\n✅ Booking confirmed: ${s.booking.booking_id}, total $${s.booking.final_price.toFixed(2)}.`;

  // Commit atomically and compactly: tool chatter is not needed in history because
  // authoritative state (quote, discount step, booking) lives on the server and is injected each turn.
  s.history = [...s.history, { role: "user", content: userText }, { role: "assistant", content: text || "(no reply)" }];
  log(s, "ASSISTANT", { text });
  return text;
}
