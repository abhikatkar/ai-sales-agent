// Provider-agnostic LLM client using the OpenAI-compatible Chat Completions format.
// Default: Google Gemini free tier (no credit card). Works with any compatible provider via .env.
const BASE_URL = process.env.LLM_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai";
const API_KEY = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;
export const MODEL = process.env.LLM_MODEL || "gemini-flash-latest";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** messages: OpenAI format. tools: [{name, description, parameters}]. Returns { text, toolCalls:[{id,name,args}], raw } */
export async function chat({ messages, tools, signal }) {
  if (!API_KEY) throw new Error("Missing GEMINI_API_KEY in .env");
  const body = {
    model: MODEL,
    messages,
    temperature: 0, // as deterministic as the model allows
    tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 429 || res.status >= 500) { // free tier rate limits: back off and retry
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    const msg = data.choices?.[0]?.message || {};
    const toolCalls = (msg.tool_calls || []).map((c, i) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      name: c.function.name,
      args: c.function.arguments ? JSON.parse(c.function.arguments) : {},
      extra: c.extra_content, // Gemini thought_signature; must be echoed back or the next call 400s
    }));
    return { text: (msg.content || "").trim(), toolCalls, raw: msg };
  }
  throw new Error("LLM rate limited after 5 retries (free tier). Wait a minute and try again.");
}
