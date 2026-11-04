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

const who = (client = "") => (client.startsWith("Java-http-client") ? "Chord" : client.startsWith("curl") ? "A manual test (curl)" : client ? `A client (${client})` : "A client");

/** One plain-English line for one request log line, or undefined if it isn't ours. */
export function explain(l: Line): string | undefined {
  if (l.status === undefined) return undefined;
  const took = l.ms === undefined ? "" : ` (${l.ms < 1000 ? `${l.ms} ms` : `${(l.ms / 1000).toFixed(1)} s`})`;
  if (STATUS[l.status]) return `${who(l.client)} → ${l.rpc ?? "?"}: ${STATUS[l.status]}${took}`;
  if (l.rpc === "tools/call") {
    const what = TOOLS[l.tool ?? ""] ?? `an unknown tool "${l.tool}"`;
    const outcome = l.outcome === "refused" ? "Refused by a business rule; the teammate was told why"
      : l.outcome === "error" ? "Failed (bad input, or the Sheet or Paystack didn't answer); the teammate was told"
      : "Done: the result went back to the teammate";
    return `${who(l.client)} called ${l.tool}: ${what}. ${outcome}${took}`;
  }
  return `${who(l.client)} ${STEPS[l.rpc ?? ""] ?? `sent ${l.rpc}`}${took}`;
}

const time = (ms: number) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: "Africa/Lagos" });

function stream(file: string) {
  let quietSince = Date.now();
  const tick = setInterval(() => {
    const mins = Math.floor((Date.now() - quietSince) / 60_000);
    if (mins >= 1) console.log(`${time(Date.now())}  · no calls for ${mins} min`);
  }, 60_000);
  const run = () => {
    const child = spawn("vercel", ["logs", "chopiefy-money-desk.vercel.app", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    let rest = "";
    child.stdout.on("data", (chunk: Buffer) => {
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
    child.on("exit", run); // the CLI stops after 5 minutes
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
Vercel's live stream can drop a line, so the dashboard's Logs tab (kept an hour) is the full record.
`);
  stream("probe-output/calls.log");
}
