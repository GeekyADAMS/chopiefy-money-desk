// The live watcher's plain-English lines (scripts/watch.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { explain } from "../scripts/watch.js";

test("explains each kind of request in plain English, naming Chord by its client", () => {
  const chord = { client: "Java-http-client/23.0.2", status: 200, ms: 5 };
  assert.match(explain({ ...chord, rpc: "tools/list" })!, /^Chord asked which tools we offer.*\(5 ms\)$/);
  assert.match(explain({ ...chord, rpc: "prompts/list" })!, /Method not found.*harmless/);
  assert.match(explain({ ...chord, rpc: "tools/call", tool: "cash_position", ms: 1543 })!, /^Chord called cash_position: checking Paystack.*Done.*\(1\.5 s\)$/);
  assert.match(explain({ ...chord, rpc: "tools/call", tool: "pay_supplier", outcome: "refused" })!, /Refused by a business rule/);
  assert.match(explain({ ...chord, rpc: "tools/call", tool: "check_status", outcome: "error" })!, /Failed \(bad input/);
  assert.match(explain({ ...chord, rpc: "tools/call", tool: "nope" })!, /unknown tool "nope"/);
  assert.match(explain({ status: 401, client: "curl/8.7.1" })!, /^A manual test \(curl\) → \?: REFUSED: wrong or missing token/);
  assert.match(explain({ rpc: "initialize", status: 500 })!, /FAILED inside our server/);
  assert.equal(explain({}), undefined);
});
