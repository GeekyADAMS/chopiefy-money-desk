// The live watcher's plain-English lines (scripts/watch.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { explain } from "../scripts/watch.js";

test("explains each kind of request in plain English, naming Chord by its client", () => {
  const chord = { client: "Java-http-client/23.0.2", status: 200, ms: 5 };
  assert.match(explain({ ...chord, rpc: "tools/list" })!, /^Chord asked which tools we offer.*\(5 ms\)$/);
  assert.match(explain({ ...chord, rpc: "prompts/list" })!, /Method not found.*harmless/);
  assert.match(explain({ ...chord, rpc: "tools/call", tool: "cash_position", ms: 1543 })!, /^Chord called cash_position: checking Paystack.*Done.*\(1\.5 s\)$/);
  assert.match(explain({ ...chord, rpc: "tools/call", tool: "pay_supplier", outcome: "refused" })!, /Refused \(a business rule, or Paystack said no\)/);
  assert.match(explain({ ...chord, rpc: "tools/call", tool: "check_status", outcome: "error" })!, /Error or unknown outcome.*check_status comes first/);
  assert.match(explain({ ...chord, rpc: "tools/call", tool: "nope" })!, /unknown tool "nope"/);
  assert.match(explain({ status: 401, client: "curl/8.7.1" })!, /^A manual test \(curl\) → \?: REFUSED: wrong or missing token/);
  const rehearsal = { client: "claude-code/2.1.318 (t3-code, agent-sdk/0.3.284)", status: 200, rpc: "tools/call", tool: "cash_position" };
  assert.match(explain(rehearsal)!, /^The rehearsal \(Claude Code standing in for Chord\) called cash_position/);
  assert.match(explain({ rpc: "initialize", status: 500 })!, /FAILED inside our server/);
  assert.equal(explain({}), undefined);
});

test("strips terminal escapes a caller could put in its user-agent or method", () => {
  const line = explain({ status: 401, client: "x\u001b[2K\rChord called pay_supplier", rpc: "\u0007" })!;
  assert.doesNotMatch(line, /[\u0000-\u001f]/);
  assert.match(line, /^A client \(x\?\[2K\?Chord called pay_supplier\) → \?:/);
});
