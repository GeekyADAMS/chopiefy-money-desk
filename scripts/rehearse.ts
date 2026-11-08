// Rehearses the demo conversation with no Chord credits and no Paystack calls (ADR 0013). The real endpoint runs on
// localhost against the in-memory Sheet and Paystack, loaded with the demo scene. Claude Code plays the teammate,
// headless, with the skill as its only system prompt and our five tools as its only tools.
// Run: pnpm rehearse [script]   (default scripts/demo-script.txt; REHEARSE_MODEL picks the model)
// pnpm rehearse --live talks to production instead: the real Sheet and Paystack test mode, with Claude Code standing
// in for Chord. It pauses at each tick and card payment for a person to do it. Run pnpm reset:demo first.
// Script lines: "> message" is staff on WhatsApp, "! tick OUT-0006" is the owner's tick, "! pay IN-0005" is a payer
// paying by card, "#" is a comment.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv, promisify } from "node:util";
import { GET, POST } from "../api/mcp.js";
import { COLUMNS } from "../lib/sheet.js";
import { lagosDate } from "../lib/rules.js";
import { fakeWorld } from "../test/fakes.js";
import { loadDemo } from "./demo-scene.js";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const file = (p: string) => readFileSync(join(root, p), "utf8");
function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

// Where the teammate's tools live, and who carries out the script's "!" lines: the fakes locally, a person when live.
interface Desk { url: string; token: string; tick(id: string): Promise<void>; pay(id: string): Promise<void>; end(): void }

async function local(): Promise<Desk> {
  const { sheet, paystack } = fakeWorld(); // must come first: it routes fetch to the fakes
  const token = (process.env.MCP_TOKEN = randomUUID());
  await loadDemo(sheet, paystack, lagosDate(new Date()));
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const answer = req.method === "POST"
      ? await POST(new Request(`http://localhost${req.url}`, { method: "POST", headers: req.headers as HeadersInit, body: Buffer.concat(chunks) }))
      : GET(); // 405, as on Vercel: the server is stateless
    res.writeHead(answer.status, Object.fromEntries(answer.headers)).end(Buffer.from(await answer.arrayBuffer()));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const row = (id: string) => sheet.tabs.Ledger.find((r) => r[0] === id) ?? stop(`${id} isn't in the Ledger`);
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp`,
    token,
    async tick(id) {
      row(id)[COLUMNS.Ledger.indexOf("approved")] = true;
      console.log(`\n[owner ticks ${id}]`);
    },
    async pay(id) {
      const code = String(row(id)[COLUMNS.Ledger.indexOf("paystack_code")]);
      paystack.pay(code);
      paystack.requests[code]!.paid_at = new Date().toISOString(); // now, not the fakes' fixed test date
      console.log(`\n[${id} is paid by card]`);
    },
    end() {
      console.log("\nLEDGER AT THE END");
      for (const r of sheet.rows("Ledger")) console.log(`  ${r.id}  ${r.party}  ₦${Number(r.amount_ngn).toLocaleString()}  ${r.status}${r.approved ? "  ticked" : ""}`);
      console.log(`Paystack transfers: ${Object.keys(paystack.transfers).length}`);
      server.close();
    },
  };
}

async function production(): Promise<Desk> {
  // Only the token is read: the other secrets in .env.local never reach this process's env, or the claude child's.
  let token: string | undefined;
  try {
    token = parseEnv(readFileSync(join(root, ".env.local"), "utf8")).MCP_TOKEN;
  } catch {
    stop("--live needs .env.local with the production MCP_TOKEN");
  }
  if (!token) stop("--live needs MCP_TOKEN in .env.local (the token Chord uses)");
  const url = "https://chopiefy-money-desk.vercel.app/api/mcp";
  const check = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
    accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  await check.body?.cancel();
  if (check.status !== 200) stop(`Production answered HTTP ${check.status} to the token in .env.local; check MCP_TOKEN`);
  // The script's IDs come from the local scene. They start higher on the live Sheet, so the person finds the row.
  // A fresh readline per pause, closed after it, so Ctrl-C stops the run during a pause and between them.
  const wait = async (what: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout }).on("SIGINT", () => process.exit(130));
    await rl.question(`\n[${what}. Press Enter when done.] `);
    rl.close();
  };
  console.log("LIVE: the real Sheet and Paystack test mode. Run pnpm reset:demo first. Live IDs are higher than the script's.");
  return {
    url,
    token,
    tick: (id) => wait(`Owner: tick approved in the Sheet on the row the script calls ${id}`),
    pay: (id) => wait(`Payer: open the pay link for the invoice the script calls ${id} and pay with a Paystack test card`),
    end: () => {},
  };
}

const desk = process.argv.includes("--live") ? await production() : await local();
const cwd = mkdtempSync(join(tmpdir(), "rehearse-")); // away from the repo's CLAUDE.md
// The token goes in a private file, never on claude's command line, where ps or an error message would show it.
const mcp = join(cwd, "mcp.json");
process.on("exit", () => rmSync(cwd, { recursive: true, force: true })); // the token file goes with the run
process.on("SIGINT", () => process.exit(130)); // so Ctrl-C mid-turn still runs the cleanup above
writeFileSync(mcp, JSON.stringify({ mcpServers: { desk: { type: "http", url: desk.url, headers: { authorization: `Bearer ${desk.token}` } } } }), { mode: 0o600 });
const today = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date());
// Chord tells the model today's date (it got overdue days right on 6 Nov), so the stand-in is told too.
const system = [`It is now ${today}, Lagos time.`, file("skill/SKILL.md"), `# references/business.md\n${file("skill/references/business.md")}`,
  `# references/examples.md\n${file("skill/references/examples.md")}`].join("\n\n");

let session: string | undefined;
let cost = 0;
const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);
const script = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "scripts/demo-script.txt";

for (const line of file(script).split("\n").map((l) => l.trim())) {
  if (line.startsWith("! tick ")) await desk.tick(line.slice(7));
  else if (line.startsWith("! pay ")) await desk.pay(line.slice(6));
  else if (line.startsWith("> ")) {
    console.log(`\nSTAFF: ${line.slice(2)}`);
    const args = ["-p", line.slice(2), "--output-format", "stream-json", "--verbose", "--system-prompt", system, "--mcp-config", mcp,
      "--strict-mcp-config", "--tools", "", "--allowedTools", "mcp__desk", "--setting-sources", "project",
      ...(process.env.REHEARSE_MODEL ? ["--model", process.env.REHEARSE_MODEL] : []), ...(session ? ["--resume", session] : [])];
    // On failure only claude's own stderr is shown: execFile's error message repeats the whole command line.
    const { stdout } = await run("claude", args, { cwd, maxBuffer: 50_000_000 })
      .catch((err: { stderr?: string }) => stop(`claude failed: ${err.stderr?.trim() || "no error output"}`));
    for (const event of stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l))) {
      for (const block of event.message?.content ?? []) {
        if (event.type === "assistant" && block.type === "text") console.log(`AGENT: ${block.text}`);
        if (event.type === "assistant" && block.type === "tool_use") console.log(`  → ${block.name.replace("mcp__desk__", "")} ${JSON.stringify(block.input)}`);
        if (event.type === "user" && block.type === "tool_result") {
          const text = Array.isArray(block.content) ? block.content.map((c: { text?: string }) => c.text ?? "").join("") : String(block.content);
          console.log(`  ← ${short(text)}`);
        }
      }
      if (event.type === "result") ({ session_id: session } = event), (cost += event.total_cost_usd ?? 0);
    }
  }
}

desk.end();
console.log(`\nModel cost: $${cost.toFixed(2)}`);
