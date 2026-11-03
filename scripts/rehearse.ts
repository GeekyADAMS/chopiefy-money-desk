// Rehearses the demo conversation with no Chord credits and no Paystack calls (ADR 0013). The real endpoint runs on
// localhost against the in-memory Sheet and Paystack, loaded with the demo scene. Claude Code plays the teammate,
// headless, with the skill as its only system prompt and our five tools as its only tools.
// Run: pnpm rehearse [script]   (default scripts/demo-script.txt; REHEARSE_MODEL picks the model)
// Script lines: "> message" is staff on WhatsApp, "! tick OUT-0006" is the owner's tick, "! pay IN-0005" is a payer
// paying by card, "#" is a comment.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { GET, POST } from "../api/mcp.js";
import { COLUMNS } from "../lib/sheet.js";
import { lagosDate } from "../lib/rules.js";
import { fakeWorld } from "../test/fakes.js";
import { loadDemo } from "./demo-scene.js";

const run = promisify(execFile);
const root = new URL("..", import.meta.url).pathname;
const { sheet, paystack } = fakeWorld(); // must come first: it routes fetch to the fakes
process.env.MCP_TOKEN = randomUUID();
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
const port = (server.address() as { port: number }).port;

const mcp = JSON.stringify({ mcpServers: { desk: { type: "http", url: `http://127.0.0.1:${port}/api/mcp`, headers: { authorization: `Bearer ${process.env.MCP_TOKEN}` } } } });
const file = (p: string) => readFileSync(join(root, p), "utf8");
const today = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date());
// ponytail: Chord's own prompt and date handling are unknown; the first real run tells us what to change here.
const system = [`It is now ${today}, Lagos time.`, file("skill/SKILL.md"), `# references/business.md\n${file("skill/references/business.md")}`,
  `# references/examples.md\n${file("skill/references/examples.md")}`].join("\n\n");
const cwd = mkdtempSync(join(tmpdir(), "rehearse-")); // away from the repo's CLAUDE.md

let session: string | undefined;
let cost = 0;
const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);
const row = (id: string) => sheet.tabs.Ledger.find((r) => r[0] === id) ?? stop(`${id} isn't in the Ledger`);
function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

for (const line of file(process.argv[2] ?? "scripts/demo-script.txt").split("\n").map((l) => l.trim())) {
  if (line.startsWith("! tick ")) {
    row(line.slice(7))[COLUMNS.Ledger.indexOf("approved")] = true;
    console.log(`\n[owner ticks ${line.slice(7)}]`);
  } else if (line.startsWith("! pay ")) {
    const code = String(row(line.slice(6))[COLUMNS.Ledger.indexOf("paystack_code")]);
    paystack.pay(code);
    paystack.requests[code]!.paid_at = new Date().toISOString(); // now, not the fakes' fixed test date
    console.log(`\n[${line.slice(6)} is paid by card]`);
  } else if (line.startsWith("> ")) {
    console.log(`\nSTAFF: ${line.slice(2)}`);
    const args = ["-p", line.slice(2), "--output-format", "stream-json", "--verbose", "--system-prompt", system, "--mcp-config", mcp,
      "--strict-mcp-config", "--tools", "", "--allowedTools", "mcp__desk", "--setting-sources", "project",
      ...(process.env.REHEARSE_MODEL ? ["--model", process.env.REHEARSE_MODEL] : []), ...(session ? ["--resume", session] : [])];
    const { stdout } = await run("claude", args, { cwd, maxBuffer: 50_000_000 });
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

console.log("\nLEDGER AT THE END");
for (const r of sheet.rows("Ledger")) console.log(`  ${r.id}  ${r.party}  ₦${Number(r.amount_ngn).toLocaleString()}  ${r.status}${r.approved ? "  ticked" : ""}`);
console.log(`\nModel cost: $${cost.toFixed(2)}; Paystack transfers: ${Object.keys(paystack.transfers).length}`);
server.close();
