// Checks the Chord skill against Chord's format (docs/chord/) and our tool contract. No network.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "../lib/tools.js";

const dir = new URL("../skill/", import.meta.url);
const skill = readFileSync(new URL("SKILL.md", dir), "utf8");
const references = readdirSync(new URL("references/", dir)).map((f) => readFileSync(new URL(`references/${f}`, dir), "utf8"));

// The tools the MCP server registers, read off the server itself.
const TOOLS: string[] = [];
registerTools({ registerTool: (name: string) => TOOLS.push(name) } as unknown as McpServer);

test("frontmatter has a kebab-case name and a description that says when to use it", () => {
  const front = skill.match(/^---\nname: ([a-z0-9-]+)\ndescription: (.+)\n---\n/);
  assert.ok(front, "SKILL.md must start with name and description frontmatter");
  assert.equal(front[1], "chopiefy-money-desk");
  assert.match(front[2], /Use when/);
});

test("follows Chord's section layout", () => {
  for (const heading of ["## Task", "## When to use it", "## Instructions", "## Rules", "## Example of a good result"]) {
    assert.ok(skill.includes(`\n${heading}\n`), `missing ${heading}`);
  }
});

test("fits Chord's 64,000-character skill budget with room to spare", () => {
  const total = [skill, ...references].reduce((n, s) => n + s.length, 0);
  assert.ok(total < 48_000, `skill is ${total} characters`);
});

test("names every tool, so the agent knows each one exists", () => {
  assert.equal(TOOLS.length, 5);
  for (const tool of TOOLS) assert.ok(skill.includes(`\`${tool}\``), `SKILL.md never mentions ${tool}`);
});

test("every reference SKILL.md links to exists", () => {
  const files = new Set(readdirSync(new URL("references/", dir)));
  for (const [, file] of skill.matchAll(/references\/([\w.-]+\.md)/g)) assert.ok(files.has(file!), `missing references/${file}`);
});

test("contains no secrets, real-looking account numbers or phone numbers", () => {
  for (const text of [skill, ...references]) {
    assert.doesNotMatch(text, /sk_(test|live)_/);
    assert.doesNotMatch(text, /\b\d{10}\b/, "write account numbers masked, like ••••1234");
    assert.doesNotMatch(text, /\+?234\d{7,}|\b0[789]0\d{8}\b/, "no phone numbers");
  }
});
