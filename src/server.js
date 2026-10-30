import express from "express";
import { getSession, log } from "./session.js";
import { runTurn } from "./agent.js";
import { get_catalog_info, BOOKINGS } from "./catalog.js";

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Raw mock APIs (so interviewers can hit them directly)
app.get("/api/catalog", (req, res) => res.json(get_catalog_info(req.query.q || "")));
app.get("/api/bookings", (_req, res) => res.json(BOOKINGS));

// Chat: turns per session are serialized through a promise queue (no races on state).
// interrupt=true aborts the in-flight LLM call; partial turns are never committed to history.
app.post("/api/chat", async (req, res) => {
  const { sessionId = "default", message, interrupt = false } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: "message required" });
  const s = getSession(sessionId);
  const fromEvent = s.events.length;

  if (interrupt && s.currentAbort) {
    s.currentAbort.abort();
    log(s, "INTERRUPT", { note: "Previous turn aborted by user" });
  }

  const job = s.queue.then(async () => {
    const ac = new AbortController();
    s.currentAbort = ac;
    try {
      const reply = await runTurn(s, message.trim(), ac.signal);
      return { reply };
    } catch (e) {
      if (ac.signal.aborted) {
        // If a booking completed before the abort, record it so the conversation stays consistent.
        if (s.booking && !s.history.some((m) => String(m.content).includes(s.booking.booking_id)))
          s.history.push({ role: "user", content: message }, { role: "assistant", content: `Booking confirmed: ${s.booking.booking_id}.` });
        return { reply: null, interrupted: true };
      }
      log(s, "ERROR", { message: e.message });
      return { reply: "Sorry, something went wrong. Please repeat your last message.", error: e.message };
    } finally {
      if (s.currentAbort === ac) s.currentAbort = null;
    }
  });
  s.queue = job.catch(() => {});
  const out = await job;
  res.json({ ...out, events: s.events.slice(fromEvent), state: { quote: s.quote, discount_step: s.ladderStep, booking: s.booking } });
});

app.post("/api/reset", (req, res) => res.json({ ok: true, note: "Use a new sessionId to start fresh." }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sales agent on http://localhost:${PORT}`));
