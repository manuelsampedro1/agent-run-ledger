import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendEvent,
  createEvent,
  demoEvents,
  readLedger,
  summarize,
  validateEvent,
  writeLedger,
} from "../src/ledger.js";
import { parseArgs, runCli } from "../src/cli.js";
import { renderReport } from "../src/report.js";

test("createEvent normalizes repeated fields", () => {
  const event = createEvent({
    type: "command",
    title: "Run tests",
    summary: "Tests passed",
    file: ["src/a.js", "src/b.js"],
    command: "npm test",
    status: "passed",
  }, new Date("2026-06-01T10:00:00.000Z"));

  assert.equal(event.type, "command");
  assert.equal(event.status, "passed");
  assert.deepEqual(event.files, ["src/a.js", "src/b.js"]);
  assert.deepEqual(event.commands, ["npm test"]);
  assert.match(event.id, /^evt_20260601100000_run-tests$/);
});

test("validateEvent rejects unsupported types and statuses", () => {
  const errors = validateEvent({
    id: "evt_bad",
    ts: "not-a-date",
    type: "thought",
    title: "Bad",
    summary: "Bad",
    status: "maybe",
  });

  assert.ok(errors.some((error) => error.includes("type must be one of")));
  assert.ok(errors.some((error) => error.includes("status must be one of")));
  assert.ok(errors.some((error) => error.includes("valid ISO timestamp")));
});

test("validateEvent requires status for command evidence", () => {
  const commandEventErrors = validateEvent({
    id: "evt_command",
    ts: "2026-06-01T10:00:00.000Z",
    type: "command",
    title: "Run tests",
    summary: "Tests ran",
    commands: ["npm test"],
  });
  const decisionWithCommandErrors = validateEvent({
    id: "evt_decision_command",
    ts: "2026-06-01T10:00:00.000Z",
    type: "decision",
    title: "Use targeted tests",
    summary: "Recorded a command as evidence.",
    commands: ["npm test"],
  });
  const validErrors = validateEvent({
    id: "evt_command_status",
    ts: "2026-06-01T10:00:00.000Z",
    type: "command",
    title: "Run tests",
    summary: "Tests passed",
    commands: ["npm test"],
    status: "passed",
  });

  assert.ok(commandEventErrors.some((error) => error.includes("status is required for command evidence")));
  assert.ok(decisionWithCommandErrors.some((error) => error.includes("status is required for command evidence")));
  assert.deepEqual(validErrors, []);
});

test("ledger writes, reads, sorts, and summarizes events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const later = createEvent({
      id: "evt_later",
      ts: "2026-06-01T10:10:00.000Z",
      type: "command",
      title: "Run tests",
      summary: "Tests passed",
      status: "passed",
      command: "npm test",
    });
    const earlier = createEvent({
      id: "evt_earlier",
      ts: "2026-06-01T10:00:00.000Z",
      type: "intent",
      title: "Start",
      summary: "Start run",
      file: "README.md",
    });

    await writeLedger(ledgerPath, [later, earlier]);
    const events = await readLedger(ledgerPath);
    const summary = summarize(events);

    assert.deepEqual(events.map((event) => event.id), ["evt_earlier", "evt_later"]);
    assert.equal(summary.eventCount, 2);
    assert.deepEqual(summary.files, ["README.md"]);
    assert.equal(summary.commands[0].command, "npm test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("appendEvent creates parent directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "nested", "ledger.jsonl");
    await appendEvent(ledgerPath, createEvent({
      type: "decision",
      title: "Choose scope",
      summary: "Keep the change local.",
    }));

    const content = await readFile(ledgerPath, "utf8");
    assert.match(content, /Choose scope/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI rejects command notes without status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    await assert.rejects(
      runCli([
        "note",
        "--ledger", ledgerPath,
        "--type", "command",
        "--title", "Run tests",
        "--summary", "Tests ran.",
        "--command", "npm test",
      ]),
      /status is required for command evidence/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseArgs supports repeatable evidence fields", () => {
  const args = parseArgs([
    "--ledger", "run.jsonl",
    "--file", "a.js",
    "--file", "b.js",
    "--command", "npm test",
    "--json",
  ]);

  assert.equal(args.ledger, "run.jsonl");
  assert.deepEqual(args.file, ["a.js", "b.js"]);
  assert.deepEqual(args.command, ["npm test"]);
  assert.equal(args.json, true);
});

test("doctor command can emit machine-readable JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));
  const originalLog = console.log;
  const lines = [];

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    await writeLedger(ledgerPath, demoEvents());
    console.log = (line) => {
      lines.push(line);
    };

    await runCli(["doctor", "--ledger", ledgerPath, "--json"]);

    const payload = JSON.parse(lines.join("\n"));
    assert.equal(payload.schema_version, "agent-run-ledger.doctor.v1");
    assert.equal(payload.ledger, ledgerPath);
    assert.equal(payload.summary.eventCount, 5);
    assert.equal(payload.summary.commands.length, 1);
    assert.equal(payload.summary.attention.length, 0);
  } finally {
    console.log = originalLog;
    await rm(dir, { recursive: true, force: true });
  }
});

test("demo command writes a ledger and report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    await runCli(["demo", "--out", dir]);
    const ledger = await readFile(join(dir, "ledger.jsonl"), "utf8");
    const report = await readFile(join(dir, "report.html"), "utf8");

    assert.equal(ledger.trim().split("\n").length, 5);
    assert.match(report, /Demo Agent Run Ledger/);
    assert.match(report, /Ready for review/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderReport escapes user-controlled text", () => {
  const html = renderReport([
    createEvent({
      type: "decision",
      title: "<script>alert(1)</script>",
      summary: "Use <b>plain</b> text.",
    }),
  ]);

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert/);
});

test("demo summary has no attention items", () => {
  const summary = summarize(demoEvents());

  assert.equal(summary.eventCount, 5);
  assert.equal(summary.attention.length, 0);
  assert.ok(summary.files.includes("src/webhooks/billing.ts"));
});
