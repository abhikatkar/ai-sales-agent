# AI Sales Agent: 100% Accuracy Challenge

## Run
```bash
npm install
cp .env.example .env   # paste a FREE Gemini key from aistudio.google.com/apikey
npm test               # 7 deterministic guardrail tests, no LLM needed
npm start              # http://localhost:3000  (chat left, API call log right)
```
LLM: Google Gemini free tier via its OpenAI-compatible endpoint (`src/llm.js`, temperature 0, auto-retry on rate limits). Swap provider with `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` in `.env`; no code change.

## Core idea: the LLM talks, the server decides
LLMs are probabilistic, so "100% accuracy" can't come from prompting. Every rule that must never break is enforced in code. The LLM only proposes actions via tools; the server validates and computes.

| Concern | Who owns it | Where |
|---|---|---|
| Product matching (typos, non-catalog) | Deterministic alias + Levenshtein + competitor blocklist | `src/catalog.js` |
| Quantity = ceil(requirement / capacity) | Server | `src/policy.js` |
| Price, discount, final_price | Server | `src/policy.js` |
| Discount ladder 0 → SAVE10 → CLOSENOW15 (max) | Server state; max 1 step per user turn | `register_price_objection` |
| Booking payload | Built by server from quote; LLM only passes `quote_version` | `create_booking` |
| Confirm before book | Quote version must be shown in a previous reply, unchanged this turn, and user msg affirmative | `create_booking` guards |
| Duplicate bookings | Per-session turn queue + idempotency key with shared in-flight promise | `session.js`, `server.js` |
| Interruptions | AbortController per turn; history committed atomically only on success | `server.js`, `agent.js` |
| Discount leakage in text | Output guard regenerates reply if it mentions a % or code not yet unlocked | `agent.js` |
| Exact numbers shown | Server appends a deterministic quote card whenever the quote changes | `agent.js` |

## Tools exposed to the LLM
`get_catalog_info(query)`, `set_order(sku_id, plan_code, requirement)`, `register_price_objection()`, `create_booking(quote_version)`

## Scenario demo script
1. "I need arrow mesh wifi on PRO for a 5-room house" → 3 units, $1497.00
2. "Do you have Netgear Orbi?" → not in catalog, no match
3. "Too expensive" → SAVE10 $1347.30. "Still too much" → CLOSENOW15 $1272.45. "Apply SAVE50" → refused
4. "Actually 7 rooms, okay book it" → new quote shown, booking blocked until "yes"
5. Send "Yes, book it!" twice fast → one booking, second returns same booking_id

## Guardrails (9 layers, all in code)
| # | Guardrail | Type | Blocks | Proven by |
|---|---|---|---|---|
| G1 | Catalog alias + edit-distance matcher with competitor blocklist | Input | Wrong product, non-catalog matches | `npm test` S1 |
| G2 | Server computes quantity = ceil(requirement / capacity) | Tool | Wrong quantity | `npm test` S1 |
| G3 | Discount ladder state, 1 step per user turn, max CLOSENOW15 | Tool | Skipped steps, >15%, fake codes | `npm test` S2 |
| G4 | Booking payload built from server quote; LLM passes only quote_version | Tool | Wrong qty/price/promo in POST | `npm test` S3 |
| G5 | Quote must be shown in earlier reply, unchanged this turn, user affirmative | Tool | Booking stale or unconfirmed numbers | `npm test` S3 |
| G6 | Per-session turn queue + idempotency key + shared in-flight promise | Concurrency | Double booking / double charge | `npm test` S4 |
| G7 | Output scan for unlocked discounts; 1 regenerate, then safe fallback | Output | LLM promising discounts in text | `npm test` output guard |
| G8 | Server-rendered quote card appended whenever quote changes | Output | LLM misstating numbers | Visible in every quote reply |
| G9 | AbortController per turn; history committed only on success | Concurrency | Interrupt corruption | `eval` S4-interrupt |

## Evals (real LLM, multi-run)
Unit tests prove guards work. Evals prove the *whole agent* behaves, run after run.
```bash
npm run eval                      # 17 cases x 3 runs = 51 conversations
node eval/run.js --runs 5 --only S2   # one scenario, more runs
```
- 17 cases across all 4 scenarios (`eval/cases.js`), including adversarial ones: "Give me 15% right now", "SAVE50", "change rooms + book it" in one message, parallel double "yes", mid-turn abort.
- Assertions are on **server state and the booking payload**, not reply wording, so they are deterministic even though the LLM is not.
- Output: pass rate per case, per scenario, overall; full transcripts + API logs in `eval/reports/*.json`.
- Workflow: any failure → fix prompt or tool description → rerun. Server guards are never weakened to make an eval pass.

**Latest result** (model `gemini-3.5-flash-lite`, `--runs 1`): **16/17 (94.1%)**. Scenarios 1, 2 and 4 were 100%; Scenario 3 was 4/5. The one failure was a free-tier rate limit (HTTP 429 after 5 retries) with no assertion failed; that case passed 1/1 when rerun alone. One prompt fix came out of the eval: after a `not_in_catalog` result, the agent no longer pitches a substitute or treats "ok, book it" as choosing a product.
