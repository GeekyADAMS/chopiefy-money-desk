// Prints every call Chord (or anyone) makes to the production MCP server as it happens, in plain English, and says so
// when nothing arrives. Reads Vercel's live runtime log, which the CLI streams for 5 minutes at a time, so it restarts
// the stream until you press Ctrl-C. Run: pnpm watch   (needs the vercel CLI, logged in and linked)
// Each explained line is also appended to probe-output/calls.log, so a run is kept as evidence.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

type Line = { rpc?: string; tool?: string; outcome?: "refused" | "error"; status?: number; ms?: number; client?: string; accept?: string; proto?: string };

const TOOLS: Record<string, string> = {
  record_invoice: "recording an invoice in the Ledger (an IN invoice also gets a Paystack pay link)",
  cash_position: "checking Paystack for new payments, then totalling who owes what",
  chase_debtor: "preparing reminders for overdue invoices (never someone who paid, at most one per 48 hours)",
  check_status: "asking Paystack whether an invoice was paid or a transfer went through",
  pay_supplier: "paying a supplier from the Paystack balance, after the server checks the rules",
};
const STEPS: Record<string, string> = {
  initialize: "opened an MCP session (the handshake; Chord skips it and goes straight to tools/list)",
  "notifications/initialized": "finished the handshake",
  "tools/list": "asked which tools we offer (Chord does this on Health, on Tools, and may before a turn)",
  "prompts/list": "asked for saved prompts. We offer none, so Chord shows \"Method not found\": harmless",
  "resources/list": "asked for resources. We offer none: harmless",
};
const STATUS: Record<number, string> = {
  401: "REFUSED: wrong or missing token. Check the bearer token stored in Chord",
  400: "REFUSED: the request wasn't valid MCP",
  406: "REFUSED: the client's Accept header",
  500: "FAILED inside our server: read the Vercel log for the error",
};

// The user-agent comes from any caller, even an unauthorised one, so control characters (terminal escapes) are
// stripped before printing. "Chord" means "claims Chord's client": a user-agent can be faked.
const clean = (s = "") => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
const who = (client = "") => (client.startsWith("Java-http-client") ? "Chord" : client.startsWith("curl") ? "A manual test (curl)"
  : client.startsWith("claude-code") ? "The rehearsal (Claude Code standing in for Chord)" : client ? `A client (${client})` : "A client");

/** One plain-English line for one request log line, or undefined if it isn't ours. */
export function explain(l: Line): string | undefined {
  if (l.status === undefined) return undefined;
  const took = l.ms === undefined ? "" : ` (${l.ms < 1000 ? `${l.ms} ms` : `${(l.ms / 1000).toFixed(1)} s`})`;
  const by = who(clean(l.client));
  if (STATUS[l.status]) return `${by} → ${clean(l.rpc ?? "?")}: ${STATUS[l.status]}${took}`;
  if (l.rpc === "tools/call") {
    const what = TOOLS[l.tool ?? ""] ?? `an unknown tool "${clean(l.tool)}"`;
    const outcome = l.outcome === "refused" ? "Refused (a business rule, or Paystack said no); the teammate was told why"
      : l.outcome === "error" ? "Error or unknown outcome: read the teammate's reply (for pay_supplier, check_status comes first)"
      : "Done: the result went back to the teammate";
    return `${by} called ${clean(l.tool)}: ${what}. ${outcome}${took}`;
  }
  return `${by} ${STEPS[l.rpc ?? ""] ?? `sent ${clean(l.rpc)}`}${took}`;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos" });

const HEARTBEATS = new Set([1, 5, 15, 30]);

function stream(file: string) {
  let quietSince = Date.now();
  let quickFailures = 0;
  const tick = setInterval(() => {
    const mins = Math.round((Date.now() - quietSince) / 60_000);
    if (HEARTBEATS.has(mins) || (mins > 0 && mins % 60 === 0)) console.log(`${time(Date.now())}  · no calls for ${mins} min`);
  }, 60_000);
  const run = () => {
    const started = Date.now();
    const child = spawn("vercel", ["logs", "chopiefy-money-desk.vercel.app", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    let rest = "";
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => (errors = (errors + chunk).slice(-2000)));
    child.stdout.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop()!;
      for (const raw of lines) {
        try {
          const entry = JSON.parse(raw) as { message?: string; timestampInMs?: number };
          const text = explain(JSON.parse(entry.message ?? "") as Line);
          if (!text) continue;
          const out = `${time(entry.timestampInMs ?? Date.now())}  ${text}`;
          console.log(out);
          appendFileSync(file, out + "\n");
          quietSince = Date.now();
        } catch {} // not one of our request lines
      }
    });
    child.on("error", (err) => {
      console.error(`Can't run the vercel CLI (${err.message}). Install it, run "vercel login", then "vercel link" in this folder.`);
      process.exit(1);
    });
    // The CLI stops after 5 minutes, and a new run also picks up a new deployment. A run that ends within seconds
    // means the CLI can't stream (logged out, not linked, offline): say so, instead of reporting "no calls".
    child.on("exit", (code) => {
      if (Date.now() - started > 10_000) return (quickFailures = 0), run();
      console.error(`vercel logs stopped at once (exit ${code}):\n${errors.trim().split("\n").slice(-3).join("\n")}`);
      if (++quickFailures >= 3) return console.error("Giving up: fix the vercel CLI and run pnpm watch again."), process.exit(1);
      setTimeout(run, 5_000);
    });
  };
  run();
  process.on("SIGINT", () => (clearInterval(tick), process.exit(0)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  mkdirSync("probe-output", { recursive: true });
  console.log(`Watching https://chopiefy-money-desk.vercel.app/api/mcp (Lagos time). Ctrl-C to stop.
When you send a message to Money Desk, a working turn looks like this:
  1. The teammate's first step decides to use a tool, e.g. cash_position.
  2. Chord calls that tool here: a "Chord called …" line appears within seconds.
  3. The result goes back, and the teammate writes its reply in Chord.
If a turn ends in Chord with no "Chord called" line here, the turn stopped inside Chord before reaching us.
Vercel's live stream can drop a line, so the dashboard's Logs tab (kept an hour) is the full record. After a
redeploy, calls show here once the stream restarts (within 5 minutes).
`);
  stream("probe-output/calls.log");
}
