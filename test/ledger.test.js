import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  doctorNeedsAttention,
  parseArgs,
  parseChecklistInput,
  parseJsonVerificationEnvelope,
  parseRepoReadinessReport,
  parseReviewPacket,
  parseVerificationChecklist,
  readinessEventsFromReport,
  reviewPacketEvents,
  runCli,
} from "../src/cli.js";
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
  assert.equal(parseArgs(["--ledger", "run.jsonl", "--strict"]).strict, true);
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
    assert.equal(payload.summary.openCommands.length, 0);
    assert.equal(payload.summary.attention.length, 0);
  } finally {
    console.log = originalLog;
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor strict marks open command evidence with a non-zero exit code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));
  const originalLog = console.log;
  const originalExitCode = process.exitCode;
  const lines = [];

  try {
    process.exitCode = undefined;
    const ledgerPath = join(dir, "ledger.jsonl");
    await writeLedger(ledgerPath, [
      createEvent({
        type: "command",
        title: "Run planned checks",
        summary: "Checks were imported but not executed yet.",
        status: "planned",
        commands: ["npm test"],
      }),
    ]);
    console.log = (line) => {
      lines.push(line);
    };

    await runCli(["doctor", "--ledger", ledgerPath, "--strict"]);
    const summary = summarize(await readLedger(ledgerPath));

    assert.equal(process.exitCode, 1);
    assert.equal(doctorNeedsAttention(summary), true);
    assert.ok(lines.includes("Open commands: 1"));
  } finally {
    console.log = originalLog;
    process.exitCode = originalExitCode;
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseVerificationChecklist extracts files and commands by section", () => {
  const entries = parseVerificationChecklist(`# Verification Checklist

## Python

- \`verify_by_change.py\`

- Run \`python3 -m py_compile\` on changed Python files.
- Run the closest targeted script or tests.

## Docs

- \`README.md\`

- Review rendered Markdown and verify links if public-facing.
`);

  assert.deepEqual(entries, [
    {
      title: "Python",
      files: ["verify_by_change.py"],
      commands: [
        "Run `python3 -m py_compile` on changed Python files.",
        "Run the closest targeted script or tests.",
      ],
    },
    {
      title: "Docs",
      files: ["README.md"],
      commands: ["Review rendered Markdown and verify links if public-facing."],
    },
  ]);
});

test("parseJsonVerificationEnvelope extracts verify-by-change categories", () => {
  const entries = parseJsonVerificationEnvelope(JSON.stringify({
    schema_version: "verify-by-change.v1",
    source: {
      type: "explicit_paths",
    },
    changed_files: ["verify_by_change.py", "README.md"],
    empty: false,
    categories: {
      python: {
        files: ["verify_by_change.py"],
        commands: [
          "Run `python3 -m py_compile` on changed Python files.",
          "Run the closest targeted script or tests.",
        ],
      },
      docs: {
        files: ["README.md"],
        commands: ["Review rendered Markdown and verify links if public-facing."],
      },
    },
  }));

  assert.deepEqual(entries, [
    {
      title: "python",
      files: ["verify_by_change.py"],
      commands: [
        "Run `python3 -m py_compile` on changed Python files.",
        "Run the closest targeted script or tests.",
      ],
    },
    {
      title: "docs",
      files: ["README.md"],
      commands: ["Review rendered Markdown and verify links if public-facing."],
    },
  ]);
});

test("parseChecklistInput falls back to markdown when JSON envelope is absent", () => {
  const entries = parseChecklistInput(`# Verification Checklist

## Docs

- \`README.md\`
- Review rendered Markdown.
`);

  assert.deepEqual(entries, [
    {
      title: "Docs",
      files: ["README.md"],
      commands: ["Review rendered Markdown."],
    },
  ]);
});

test("import-checklist appends planned command events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const checklistPath = join(dir, "checklist.md");
    await writeFile(checklistPath, `# Verification Checklist

## Python

- \`verify_by_change.py\`

- Run \`python3 -m py_compile\` on changed Python files.

## Docs

- \`README.md\`

- Review rendered Markdown and verify links if public-facing.
`, "utf8");

    await runCli(["import-checklist", "--ledger", ledgerPath, "--checklist", checklistPath]);
    const events = await readLedger(ledgerPath);

    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.type), ["command", "command"]);
    assert.deepEqual(events.map((event) => event.status), ["planned", "planned"]);
    assert.deepEqual(events[0].files, ["verify_by_change.py"]);
    assert.deepEqual(events[0].commands, ["Run `python3 -m py_compile` on changed Python files."]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("import-checklist appends planned command events from JSON envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const checklistPath = join(dir, "checklist.json");
    await writeFile(checklistPath, JSON.stringify({
      schema_version: "verify-by-change.v1",
      source: {
        type: "explicit_paths",
      },
      changed_files: ["verify_by_change.py", "README.md"],
      empty: false,
      categories: {
        python: {
          files: ["verify_by_change.py"],
          commands: ["Run `python3 -m py_compile` on changed Python files."],
        },
        docs: {
          files: ["README.md"],
          commands: ["Review rendered Markdown and verify links if public-facing."],
        },
      },
    }), "utf8");

    await runCli(["import-checklist", "--ledger", ledgerPath, "--checklist", checklistPath]);
    const events = await readLedger(ledgerPath);

    assert.equal(events.length, 2);
    assert.deepEqual(events.map((event) => event.title), ["Verify python", "Verify docs"]);
    assert.deepEqual(events.map((event) => event.status), ["planned", "planned"]);
    assert.deepEqual(events[0].files, ["verify_by_change.py"]);
    assert.deepEqual(events[1].commands, ["Review rendered Markdown and verify links if public-facing."]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseRepoReadinessReport normalizes repo-flightcheck JSON", () => {
  const report = parseRepoReadinessReport(JSON.stringify({
    stack: "python",
    summary: {
      score: 84,
      pointsPossible: 100,
      passed: 10,
      warnings: 2,
      failed: 1,
      criticalFailures: 1,
    },
    checks: [
      {
        title: "Verification command",
        status: "fail",
        severity: "critical",
        message: "No reliable verification command detected.",
        fix: "Expose one obvious test command.",
        evidence: ["README.md: python3 -m unittest discover -s tests"],
      },
    ],
    nextFixes: ["Verification command: expose one obvious test command."],
  }));

  assert.equal(report.stack, "python");
  assert.equal(report.summary.score, 84);
  assert.equal(report.summary.criticalFailures, 1);
  assert.equal(report.checks[0].title, "Verification command");
  assert.deepEqual(report.nextFixes, ["Verification command: expose one obvious test command."]);
});

test("readinessEventsFromReport marks clean readiness as passed", () => {
  const report = parseRepoReadinessReport(JSON.stringify({
    stack: "node",
    summary: {
      score: 100,
      pointsPossible: 100,
      passed: 14,
      warnings: 0,
      failed: 0,
      criticalFailures: 0,
    },
    checks: [],
    nextFixes: [],
  }));

  const events = readinessEventsFromReport(report, {
    source: "/tmp/readiness.json",
    command: "repo-flightcheck --json",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "command");
  assert.equal(events[0].status, "passed");
  assert.deepEqual(events[0].commands, ["repo-flightcheck --json"]);
  assert.deepEqual(events[0].files, ["/tmp/readiness.json"]);
});

test("readinessEventsFromReport records failed checks as blockers", () => {
  const report = parseRepoReadinessReport(JSON.stringify({
    stack: "generic",
    summary: {
      score: 48,
      pointsPossible: 100,
      passed: 5,
      warnings: 4,
      failed: 1,
      criticalFailures: 1,
    },
    checks: [
      {
        title: "Verification command",
        status: "fail",
        severity: "critical",
        message: "No reliable verification command detected.",
        fix: "Expose one obvious test command.",
        evidence: ["README.md: npm test"],
      },
      {
        title: "CI workflow",
        status: "warn",
        severity: "high",
        message: "No GitHub Actions workflow detected.",
        evidence: [".github/workflows/ci.yml"],
      },
    ],
    nextFixes: [],
  }));

  const events = readinessEventsFromReport(report, {
    source: "/tmp/readiness.json",
  });

  assert.equal(events.length, 3);
  assert.equal(events[0].status, "blocked");
  assert.equal(events[1].type, "blocker");
  assert.equal(events[1].status, "blocked");
  assert.equal(events[1].title, "Readiness fail: Verification command");
  assert.ok(events[1].summary.includes("Expose one obvious test command."));
  assert.deepEqual(events[1].files, ["/tmp/readiness.json", "README.md"]);
  assert.equal(events[2].type, "decision");
  assert.equal(events[2].status, undefined);
});

test("import-readiness appends summary and attention events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const readinessPath = join(dir, "readiness.json");
    await writeFile(readinessPath, JSON.stringify({
      stack: "generic",
      summary: {
        score: 48,
        pointsPossible: 100,
        passed: 5,
        warnings: 0,
        failed: 1,
        criticalFailures: 1,
      },
      checks: [
        {
          title: "Verification command",
          status: "fail",
          severity: "critical",
          message: "No reliable verification command detected.",
          fix: "Expose one obvious test command.",
          evidence: ["README.md: npm test"],
        },
      ],
      nextFixes: [],
    }), "utf8");

    await runCli([
      "import-readiness",
      "--ledger", ledgerPath,
      "--readiness-report", readinessPath,
      "--command", "node bin/repo-flightcheck.js . --json",
    ]);
    const events = await readLedger(ledgerPath);
    const summary = summarize(events);

    assert.equal(events.length, 2);
    assert.equal(events[0].title, "Repo readiness: 48/100");
    assert.equal(events[0].status, "blocked");
    assert.equal(events[1].type, "blocker");
    assert.equal(summary.attention.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseReviewPacket extracts repo, base, changed files, and review lanes", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`working tree\`

## Changed Files

- \`README.md\`
- \`src/app.js\`

## Review Map

### Product and docs

Focus: Check user-facing claims and TODO follow-through.

- \`README.md\`

### Application code

Focus: Check correctness and regressions.

- \`src/app.js\`

## Diff

\`\`\`diff
...
\`\`\`
`);

  assert.equal(packet.repo, "/tmp/repo");
  assert.equal(packet.base, "working tree");
  assert.deepEqual(packet.changedFiles, ["README.md", "src/app.js"]);
  assert.deepEqual(packet.lanes, [
    {
      title: "Product and docs",
      focus: "Check user-facing claims and TODO follow-through.",
      files: ["README.md"],
    },
    {
      title: "Application code",
      focus: "Check correctness and regressions.",
      files: ["src/app.js"],
    },
  ]);
});

test("reviewPacketEvents turns review packet lanes into ledger evidence", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`README.md\`

## Review Map

### Product and docs

Focus: Check docs.

- \`README.md\`
`);

  const events = reviewPacketEvents(packet, {
    source: "/tmp/review-packet.md",
    command: "python3 codex_review_packet.py --repo .",
    link: "https://github.com/example/repo/commit/abc",
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "decision");
  assert.equal(events[0].status, "done");
  assert.equal(events[0].title, "Review packet: 1 changed file");
  assert.deepEqual(events[0].files, ["/tmp/review-packet.md", "README.md"]);
  assert.deepEqual(events[0].commands, ["python3 codex_review_packet.py --repo ."]);
  assert.deepEqual(events[0].links, ["https://github.com/example/repo/commit/abc"]);
  assert.equal(events[1].title, "Review lane: Product and docs");
  assert.equal(events[1].summary, "Check docs.");
});

test("import-review-packet appends packet summary and review lane events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const packetPath = join(dir, "review-packet.md");
    await writeFile(packetPath, `# Review Packet

Repo: \`/tmp/repo\`
Base: \`working tree\`

## Changed Files

- \`README.md\`
- \`src/app.js\`

## Review Map

### Product and docs

Focus: Check docs.

- \`README.md\`

### Application code

Focus: Check app behavior.

- \`src/app.js\`
`, "utf8");

    await runCli([
      "import-review-packet",
      "--ledger", ledgerPath,
      "--packet", packetPath,
      "--command", "python3 codex_review_packet.py --repo .",
    ]);
    const events = await readLedger(ledgerPath);
    const summary = summarize(events);

    assert.equal(events.length, 3);
    assert.equal(events[0].title, "Review packet: 2 changed files");
    assert.deepEqual(events.map((event) => event.type), ["decision", "decision", "decision"]);
    assert.ok(summary.files.includes(packetPath));
    assert.ok(summary.files.includes("src/app.js"));
    assert.equal(summary.commands[0].command, "python3 codex_review_packet.py --repo .");
  } finally {
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
