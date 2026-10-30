// Usage: node eval/run.js [--runs 3] [--only S2]
// Runs every case N times against the real LLM and reports pass rate per case and scenario.
import { writeFileSync, mkdirSync } from "node:fs";
import { getSession } from "../src/session.js";
import { runTurn } from "../src/agent.js";
import { BOOKINGS } from "../src/catalog.js";
import { CASES } from "./cases.js";

const args = process.argv.slice(2);
const RUNS = Number(args[args.indexOf("--runs") + 1]) || 3;
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

if (!process.env.GEMINI_API_KEY && !process.env.LLM_API_KEY) { console.error("Set GEMINI_API_KEY in .env to run evals."); process.exit(1); }

// Same serialization the server uses: one turn at a time per session.
function send(s, text, ctx, abortAfter) {
  const job = s.queue.then(async () => {
    const ac = new AbortController();
    const timer = abortAfter ? setTimeout(() => ac.abort(), abortAfter) : null;
    try { return await runTurn(s, text, ac.signal); }
    catch (e) { if (!ac.signal.aborted) { ctx.errors++; ctx.errorMsgs.push(e.message); } return "(interrupted)"; }
    finally { clearTimeout(timer); }
  });
  s.queue = job.catch(() => {});
  return job;
}

async function runCase(c, run) {
  const s = getSession(`eval-${c.id}-${run}-${Date.now()}`);
  const ctx = { errors: 0, errorMsgs: [], bookingsCreated: 0 };
  const before = BOOKINGS.length;
  const replies = [];
  for (const t of c.turns) {
    if (typeof t === "string") replies.push(await send(s, t, ctx));
    else if (t.parallel) replies.push(...(await Promise.all(t.parallel.map((m) => send(s, m, ctx)))));
    else if (t.interrupt) replies.push(await send(s, t.interrupt, ctx, t.after_ms));
  }
  ctx.bookingsCreated = BOOKINGS.length - before;
  const failures = c.checks(s, replies, ctx).filter(Boolean);
  if (ctx.errors) failures.push(...ctx.errorMsgs);
  return { pass: failures.length === 0, failures, replies, events: s.events };
}

const cases = CASES.filter((c) => !ONLY || c.id.startsWith(ONLY));
const results = [];
console.log(`Running ${cases.length} cases x ${RUNS} runs = ${cases.length * RUNS} conversations\n`);
for (const c of cases) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await runCase(c, i));
  const passed = runs.filter((r) => r.pass).length;
  results.push({ id: c.id, scenario: c.scenario, passed, total: RUNS, runs });
  console.log(`${passed === RUNS ? "PASS" : "FAIL"}  ${c.id.padEnd(30)} ${passed}/${RUNS}`);
  runs.filter((r) => !r.pass).forEach((r) => console.log(`      ↳ ${r.failures.join("; ")}`));
}

const total = results.reduce((a, r) => a + r.total, 0);
const passed = results.reduce((a, r) => a + r.passed, 0);
console.log("\nBy scenario:");
for (const sc of [1, 2, 3, 4]) {
  const rs = results.filter((r) => r.scenario === sc);
  if (!rs.length) continue;
  const p = rs.reduce((a, r) => a + r.passed, 0), t = rs.reduce((a, r) => a + r.total, 0);
  console.log(`  Scenario ${sc}: ${p}/${t} (${((p / t) * 100).toFixed(1)}%)`);
}
console.log(`\nOVERALL: ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)`);

mkdirSync("eval/reports", { recursive: true });
const file = `eval/reports/report-${Date.now()}.json`;
writeFileSync(file, JSON.stringify({ model: process.env.LLM_MODEL || "gemini-flash-latest", runs: RUNS, passed, total, results }, null, 2));
console.log(`Full transcripts + API call logs: ${file}`);
process.exit(passed === total ? 0 : 1);
