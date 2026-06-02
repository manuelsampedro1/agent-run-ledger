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
  ciRunEvent,
  parseArgs,
  parseChecklistInput,
  parseGitHubActionsRun,
  parseJsonVerificationEnvelope,
  parseRenderedVerificationEnvelope,
  parseVerificationEnvelopeReadiness,
  parseVerificationEnvelopeTaskContract,
  parseRepoReadinessReport,
  parseReviewPacket,
  parseReviewPacketCiEvidence,
  parseReviewPacketPublishedHead,
  parseReviewPacketReadiness,
  parseReviewPacketSensitiveChanges,
  parseReviewPacketTaskContract,
  parseVerificationChecklist,
  readinessEventsFromReport,
  readinessEventsFromVerificationEnvelope,
  reviewPacketEvents,
  runCli,
  taskContractEventsFromVerificationEnvelope,
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

test("parseGitHubActionsRun normalizes single run and list payloads", () => {
  const single = parseGitHubActionsRun(JSON.stringify({
    id: 123,
    name: "CI",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/example/repo/actions/runs/123",
    head_sha: "abc123",
    head_branch: "main",
    event: "push",
  }));
  const fromList = parseGitHubActionsRun(JSON.stringify({
    workflow_runs: [
      {
        id: 456,
        name: "build",
        status: "in_progress",
        conclusion: null,
      },
    ],
  }));

  assert.deepEqual(single, {
    id: "123",
    name: "CI",
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/example/repo/actions/runs/123",
    headSha: "abc123",
    headBranch: "main",
    event: "push",
  });
  assert.equal(fromList.id, "456");
  assert.equal(fromList.conclusion, null);
});

test("ciRunEvent maps GitHub Actions conclusions to command evidence", () => {
  const passed = ciRunEvent(parseGitHubActionsRun(JSON.stringify({
    id: 123,
    name: "CI",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/example/repo/actions/runs/123",
    head_sha: "abc123",
    head_branch: "main",
  })), {
    source: "/tmp/ci-run.json",
  });
  const failed = ciRunEvent(parseGitHubActionsRun(JSON.stringify({
    id: 124,
    name: "CI",
    status: "completed",
    conclusion: "failure",
  })));
  const running = ciRunEvent(parseGitHubActionsRun(JSON.stringify({
    id: 125,
    name: "CI",
    status: "in_progress",
    conclusion: null,
  })));

  assert.equal(passed.type, "command");
  assert.equal(passed.status, "passed");
  assert.equal(passed.title, "CI passed: CI");
  assert.deepEqual(passed.commands, ["GitHub Actions: CI"]);
  assert.deepEqual(passed.files, ["/tmp/ci-run.json"]);
  assert.deepEqual(passed.links, ["https://github.com/example/repo/actions/runs/123"]);
  assert.match(passed.summary, /sha abc123/);
  assert.equal(failed.status, "failed");
  assert.equal(running.status, "running");
});

test("import-ci appends GitHub Actions evidence to a ledger", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));
  const originalLog = console.log;
  const lines = [];

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const ciRunPath = join(dir, "ci-run.json");
    await writeFile(ciRunPath, JSON.stringify({
      id: 123,
      name: "CI",
      status: "completed",
      conclusion: "success",
      html_url: "https://github.com/example/repo/actions/runs/123",
      head_sha: "abc123",
      head_branch: "main",
    }));
    console.log = (line) => {
      lines.push(line);
    };

    await runCli([
      "import-ci",
      "--ledger", ledgerPath,
      "--ci-run", ciRunPath,
      "--command", "GitHub Actions CI",
    ]);

    const events = await readLedger(ledgerPath);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, "passed");
    assert.deepEqual(events[0].commands, ["GitHub Actions CI"]);
    assert.ok(lines.includes(`Imported CI run evidence into ${ledgerPath}`));
  } finally {
    console.log = originalLog;
    await rm(dir, { recursive: true, force: true });
  }
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

test("parseRenderedVerificationEnvelope extracts rendered packet metadata and entries", () => {
  const envelope = parseRenderedVerificationEnvelope(`Source: \`verify-by-change: /tmp/verify_by_change.py\`
Envelope: \`verify-by-change.v1\`
Verification source: \`git, repo=/tmp/repo\`

\`\`\`md
# Verification Checklist

Changed files:

- \`README.md\`

## Docs

- \`README.md\`

- Review rendered Markdown and verify links if public-facing.
\`\`\`
`);

  assert.equal(envelope.schemaVersion, "verify-by-change.v1");
  assert.equal(envelope.source, "verify-by-change: /tmp/verify_by_change.py");
  assert.equal(envelope.verificationSource, "git, repo=/tmp/repo");
  assert.deepEqual(envelope.entries, [
    {
      title: "Docs",
      files: ["README.md"],
      commands: ["Review rendered Markdown and verify links if public-facing."],
    },
  ]);
});

test("parseVerificationEnvelopeReadiness extracts embedded repo readiness", () => {
  const report = parseVerificationEnvelopeReadiness(JSON.stringify({
    schema_version: "verify-by-change.v1",
    source: {
      type: "review_packet",
    },
    changed_files: ["README.md"],
    empty: false,
    categories: {
      docs: {
        files: ["README.md"],
        commands: ["Review rendered Markdown and verify links if public-facing."],
      },
    },
    repo_readiness: {
      present: true,
      contract: "repo-flightcheck.agent-contract.v1",
      ready: false,
      score: 96,
      points_possible: 100,
      threshold: 80,
      stack: "python",
      required_blockers: 1,
      recommendations: 2,
      failed: null,
      critical_failures: 0,
    },
  }));

  assert.equal(report.stack, "python");
  assert.equal(report.summary.score, 96);
  assert.equal(report.summary.pointsPossible, 100);
  assert.equal(report.summary.requiredBlockers, 1);
  assert.equal(report.summary.warnings, 2);
  assert.equal(report.summary.failed, 1);
  assert.deepEqual(report.checks, []);
});

test("parseVerificationEnvelopeTaskContract extracts embedded task contract metadata", () => {
  const contract = parseVerificationEnvelopeTaskContract(JSON.stringify({
    schema_version: "verify-by-change.v1",
    source: {
      type: "review_packet",
    },
    changed_files: ["README.md"],
    empty: false,
    categories: {
      docs: {
        files: ["README.md"],
        commands: ["Review rendered Markdown."],
      },
    },
    task_contract: {
      source: "/tmp/AGENT_TASK.md",
      status: "warn",
      required_sections: "6/8",
      missing_sections: ["Risks", "Out of Scope"],
      placeholder_markers: ["Objective"],
    },
  }));

  assert.deepEqual(contract, {
    source: "/tmp/AGENT_TASK.md",
    status: "warn",
    requiredSections: "6/8",
    missingSections: ["Risks", "Out of Scope"],
    placeholderMarkers: ["Objective"],
  });
});

test("taskContractEventsFromVerificationEnvelope records embedded task contract status", () => {
  const events = taskContractEventsFromVerificationEnvelope(JSON.stringify({
    schema_version: "verify-by-change.v1",
    source: {
      type: "review_packet",
    },
    changed_files: ["README.md"],
    empty: false,
    categories: {
      docs: {
        files: ["README.md"],
        commands: ["Review rendered Markdown."],
      },
    },
    task_contract: {
      source: "/tmp/AGENT_TASK.md",
      status: "pass",
      required_sections: "8/8",
      missing_sections: [],
      placeholder_markers: [],
    },
  }), {
    source: "/tmp/verification-envelope.json",
    link: "https://github.com/example/repo/commit/abc",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "decision");
  assert.equal(events[0].title, "Task contract passed");
  assert.equal(events[0].status, "done");
  assert.deepEqual(events[0].files, ["/tmp/verification-envelope.json", "/tmp/AGENT_TASK.md"]);
  assert.deepEqual(events[0].links, ["https://github.com/example/repo/commit/abc"]);
  assert.match(events[0].summary, /Required sections: 8\/8/);
});

test("readinessEventsFromVerificationEnvelope records embedded readiness status", () => {
  const events = readinessEventsFromVerificationEnvelope(JSON.stringify({
    schema_version: "verify-by-change.v1",
    source: {
      type: "review_packet",
    },
    changed_files: ["README.md"],
    empty: false,
    categories: {
      docs: {
        files: ["README.md"],
        commands: ["Review rendered Markdown and verify links if public-facing."],
      },
    },
    repo_readiness: {
      present: true,
      ready: false,
      score: 96,
      points_possible: 100,
      required_blockers: 1,
      recommendations: 0,
      critical_failures: 0,
    },
  }), {
    source: "/tmp/verification-envelope.json",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, "command");
  assert.equal(events[0].title, "Repo readiness: 96/100");
  assert.equal(events[0].status, "blocked");
  assert.ok(events[0].summary.includes("1 required blockers"));
  assert.deepEqual(events[0].files, ["/tmp/verification-envelope.json"]);
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

test("import-checklist appends readiness evidence from JSON envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const checklistPath = join(dir, "verification-envelope.json");
    await writeFile(checklistPath, JSON.stringify({
      schema_version: "verify-by-change.v1",
      source: {
        type: "review_packet",
      },
      changed_files: ["README.md"],
      empty: false,
      categories: {
        docs: {
          files: ["README.md"],
          commands: ["Review rendered Markdown and verify links if public-facing."],
        },
      },
      repo_readiness: {
        present: true,
        ready: true,
        score: 100,
        points_possible: 100,
        required_blockers: 0,
        recommendations: 0,
        critical_failures: 0,
      },
    }), "utf8");

    await runCli(["import-checklist", "--ledger", ledgerPath, "--checklist", checklistPath]);
    const events = await readLedger(ledgerPath);

    assert.equal(events.length, 2);
    assert.equal(events[0].title, "Repo readiness: 100/100");
    assert.equal(events[0].status, "passed");
    assert.deepEqual(events[0].files, [checklistPath]);
    assert.equal(events[1].title, "Verify docs");
    assert.equal(events[1].status, "planned");
    assert.deepEqual(events[1].commands, ["Review rendered Markdown and verify links if public-facing."]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("import-checklist appends task contract evidence from JSON envelope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const checklistPath = join(dir, "verification-envelope.json");
    await writeFile(checklistPath, JSON.stringify({
      schema_version: "verify-by-change.v1",
      source: {
        type: "review_packet",
      },
      changed_files: ["README.md"],
      empty: false,
      categories: {
        docs: {
          files: ["README.md"],
          commands: ["Review rendered Markdown and verify links if public-facing."],
        },
      },
      task_contract: {
        source: "/tmp/AGENT_TASK.md",
        status: "warn",
        required_sections: "7/8",
        missing_sections: ["Risks"],
        placeholder_markers: [],
      },
    }), "utf8");

    await runCli(["import-checklist", "--ledger", ledgerPath, "--checklist", checklistPath]);
    const events = await readLedger(ledgerPath);
    const summary = summarize(events);

    assert.equal(events.length, 2);
    assert.equal(events[0].type, "blocker");
    assert.equal(events[0].title, "Task contract needs attention");
    assert.equal(events[0].status, "blocked");
    assert.deepEqual(events[0].files, [checklistPath, "/tmp/AGENT_TASK.md"]);
    assert.match(events[0].summary, /Missing sections: Risks/);
    assert.equal(events[1].title, "Verify docs");
    assert.equal(events[1].status, "planned");
    assert.equal(summary.attention.length, 1);
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

test("parseRepoReadinessReport normalizes repo-flightcheck agent contracts", () => {
  const report = parseRepoReadinessReport(JSON.stringify({
    schemaVersion: "repo-flightcheck.agent-contract.v1",
    stack: "node",
    ready: false,
    threshold: 80,
    score: 96,
    criticalFailures: 0,
    commands: {
      test: "npm test",
      build: "npm run build",
      lint: "npm run lint",
    },
    requiredBeforeAgent: [
      {
        title: "Working tree",
        status: "warn",
        severity: "high",
        message: "Working tree has changed paths.",
        fix: "Start from a clean Git state.",
        evidence: [" M README.md"],
      },
    ],
    recommendedBeforeAgent: [
      {
        title: "License",
        status: "warn",
        severity: "medium",
        message: "No license file found.",
        fix: "Add an explicit license.",
        evidence: [],
      },
    ],
    nextFixes: ["Working tree: Start from a clean Git state."],
  }));

  assert.equal(report.stack, "node");
  assert.equal(report.summary.score, 96);
  assert.equal(report.summary.requiredBlockers, 1);
  assert.equal(report.summary.warnings, 1);
  assert.equal(report.checks[0].title, "Working tree");
  assert.equal(report.checks[0].required, true);
  assert.equal(report.checks[1].required, false);
  assert.deepEqual(report.nextFixes, ["Working tree: Start from a clean Git state."]);
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

test("readinessEventsFromReport records required contract checks as blockers", () => {
  const report = parseRepoReadinessReport(JSON.stringify({
    schemaVersion: "repo-flightcheck.agent-contract.v1",
    stack: "node",
    ready: false,
    threshold: 80,
    score: 96,
    criticalFailures: 0,
    requiredBeforeAgent: [
      {
        title: "Working tree",
        status: "warn",
        severity: "high",
        message: "Working tree has 1 changed path.",
        fix: "Start from a clean Git state.",
        evidence: [" M README.md"],
      },
    ],
    recommendedBeforeAgent: [
      {
        title: "License",
        status: "warn",
        severity: "medium",
        message: "No license file found.",
        evidence: [],
      },
    ],
    nextFixes: [],
  }));

  const events = readinessEventsFromReport(report, {
    source: "/tmp/repo-contract.json",
    command: "repo-flightcheck --contract",
  });

  assert.equal(events.length, 3);
  assert.equal(events[0].status, "blocked");
  assert.ok(events[0].summary.includes("1 required blockers"));
  assert.deepEqual(events[0].commands, ["repo-flightcheck --contract"]);
  assert.deepEqual(events[0].files, ["/tmp/repo-contract.json", "README.md"]);
  assert.equal(events[1].type, "blocker");
  assert.equal(events[1].status, "blocked");
  assert.equal(events[1].title, "Readiness warn: Working tree");
  assert.deepEqual(events[1].files, ["/tmp/repo-contract.json", "README.md"]);
  assert.equal(events[2].type, "decision");
  assert.equal(events[2].status, undefined);
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

test("parseReviewPacketReadiness extracts contract summaries from packets", () => {
  const report = parseReviewPacketReadiness(`Source: \`/tmp/repo-readiness-contract.json\`

- Contract: \`repo-flightcheck.agent-contract.v1\`
- Ready: \`false\`
- Score: \`96/100\`
- Threshold: \`80\`
- Stack: \`node\`
- Summary: \`1\` required blockers, \`1\` recommendations, \`0\` critical failures.

Required before agent:

- \`WARN\` Working tree: Working tree has 1 changed path.

Recommended before agent:

- \`WARN\` License: No license file found.

Next fixes:

- Working tree: Start from a clean Git state.
`);

  assert.equal(report.stack, "node");
  assert.equal(report.summary.score, 96);
  assert.equal(report.summary.pointsPossible, 100);
  assert.equal(report.summary.requiredBlockers, 1);
  assert.equal(report.summary.warnings, 1);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.criticalFailures, 0);
  assert.deepEqual(report.checks, [
    {
      title: "Working tree",
      status: "warn",
      severity: "unknown",
      message: "Working tree has 1 changed path.",
      fix: "",
      evidence: [],
      required: true,
    },
    {
      title: "License",
      status: "warn",
      severity: "unknown",
      message: "No license file found.",
      fix: "",
      evidence: [],
      required: false,
    },
  ]);
  assert.deepEqual(report.nextFixes, ["Working tree: Start from a clean Git state."]);
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

test("import-readiness accepts repo-flightcheck agent contracts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const readinessPath = join(dir, "readiness-contract.json");
    await writeFile(readinessPath, JSON.stringify({
      schemaVersion: "repo-flightcheck.agent-contract.v1",
      stack: "node",
      ready: false,
      threshold: 80,
      score: 96,
      criticalFailures: 0,
      requiredBeforeAgent: [
        {
          title: "Working tree",
          status: "warn",
          severity: "high",
          message: "Working tree has changed paths.",
          fix: "Start from a clean Git state.",
          evidence: [" M README.md"],
        },
      ],
      recommendedBeforeAgent: [],
      nextFixes: ["Working tree: Start from a clean Git state."],
    }), "utf8");

    await runCli([
      "import-readiness",
      "--ledger", ledgerPath,
      "--readiness-report", readinessPath,
      "--command", "node bin/repo-flightcheck.js . --contract",
    ]);
    const events = await readLedger(ledgerPath);
    const summary = summarize(events);

    assert.equal(events.length, 2);
    assert.equal(events[0].title, "Repo readiness: 96/100");
    assert.equal(events[0].status, "blocked");
    assert.deepEqual(events[0].commands, ["node bin/repo-flightcheck.js . --contract"]);
    assert.equal(events[1].type, "blocker");
    assert.equal(events[1].status, "blocked");
    assert.deepEqual(events[1].files, [readinessPath, "README.md"]);
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
  assert.deepEqual(packet.verificationEntries, []);
});

test("parseReviewPacket extracts sensitive changes without polluting review lanes", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`.env\`
- \`permission_protocol/client.py\`
- \`scripts/deploy.sh\`

## Review Map

### Security and permissions

Focus: Check auth, approval, and secret-handling behavior.

- \`permission_protocol/client.py\`

### CI and release

Focus: Check release and deployment assumptions.

- \`scripts/deploy.sh\`

## Sensitive Change Check

These paths need explicit risk review before merge.

### Secret material

- \`.env\`

### Authorization and approval

- \`permission_protocol/client.py\`

### Deploy or release path

- \`scripts/deploy.sh\`
`);

  assert.deepEqual(packet.lanes, [
    {
      title: "Security and permissions",
      focus: "Check auth, approval, and secret-handling behavior.",
      files: ["permission_protocol/client.py"],
    },
    {
      title: "CI and release",
      focus: "Check release and deployment assumptions.",
      files: ["scripts/deploy.sh"],
    },
  ]);
  assert.deepEqual(packet.sensitiveChanges, [
    {
      title: "Secret material",
      files: [".env"],
    },
    {
      title: "Authorization and approval",
      files: ["permission_protocol/client.py"],
    },
    {
      title: "Deploy or release path",
      files: ["scripts/deploy.sh"],
    },
  ]);
});

test("parseReviewPacketSensitiveChanges ignores empty sections", () => {
  assert.deepEqual(parseReviewPacketSensitiveChanges(""), []);
  assert.deepEqual(parseReviewPacketSensitiveChanges(`These paths need explicit risk review before merge.

### Secret material
`), []);
});

test("parseReviewPacketCiEvidence extracts embedded GitHub Actions evidence", () => {
  const run = parseReviewPacketCiEvidence(`Source: \`/tmp/ci-run.json\`

- Run: \`26801172625\`
- Workflow: \`CI\`
- Status: \`completed\`
- Conclusion: \`success\`
- Branch: \`main\`
- SHA: \`25b526a9aa7e252d3da12fc26e10affb40bfc1cd\`
- Event: \`push\`
- URL: <https://github.com/example/repo/actions/runs/26801172625>
`);

  assert.deepEqual(run, {
    id: "26801172625",
    name: "CI",
    status: "completed",
    conclusion: "success",
    htmlUrl: "https://github.com/example/repo/actions/runs/26801172625",
    headSha: "25b526a9aa7e252d3da12fc26e10affb40bfc1cd",
    headBranch: "main",
    event: "push",
    source: "/tmp/ci-run.json",
  });
});

test("parseReviewPacketCiEvidence treats null conclusions as incomplete evidence", () => {
  const run = parseReviewPacketCiEvidence(`Source: \`/tmp/ci-run.json\`

- Run: \`123\`
- Workflow: \`CI\`
- Status: \`in_progress\`
- Conclusion: \`null\`
`);

  assert.equal(run.conclusion, null);
  assert.equal(ciRunEvent(run).status, "running");
});

test("parseReviewPacketPublishedHead extracts pass evidence", () => {
  const proof = parseReviewPacketPublishedHead(`Source: \`/tmp/published-head.json\`

- Status: \`pass\`
- Message: Origin remote is reachable and local HEAD is published on origin/main.
- Schema: \`repo-flightcheck\`
- Remote: \`https://github.com/example/repo.git\`
- Branch: \`main\`
- Local HEAD: \`abc123\`
- Remote HEAD: \`abc123\`
- Commit URL: <https://github.com/example/repo/commit/abc123>
- CI URL: <https://github.com/example/repo/actions/runs/123>

Evidence:
- \`origin/main: abc123\`
`);

  assert.deepEqual(proof, {
    status: "pass",
    message: "Origin remote is reachable and local HEAD is published on origin/main.",
    schema: "repo-flightcheck",
    source: "/tmp/published-head.json",
    remote: "https://github.com/example/repo.git",
    branch: "main",
    localHead: "abc123",
    remoteHead: "abc123",
    commitUrl: "https://github.com/example/repo/commit/abc123",
    ciUrl: "https://github.com/example/repo/actions/runs/123",
    evidence: ["origin/main: abc123"],
  });
});

test("parseReviewPacket extracts embedded verification checklist from fenced packet section", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`working tree\`

## Repo Context

### README.md

\`\`\`md
# Example

## Verification Checklist

This heading is repo context, not the packet verification section.
\`\`\`

## Changed Files

- \`README.md\`

## Review Map

### Product and docs

Focus: Check docs.

- \`README.md\`

## Verification Checklist

Source: \`/tmp/verification-envelope.json\`
Envelope: \`verify-by-change.v1\`
Verification source: \`explicit_paths\`

\`\`\`md
# Verification Checklist

Changed files:

- \`README.md\`

## Docs

- \`README.md\`

- Review rendered Markdown and verify links if public-facing.
\`\`\`

## Suggested Review Prompt

\`\`\`text
Review this change.
\`\`\`
`);

  assert.deepEqual(packet.changedFiles, ["README.md"]);
  assert.deepEqual(packet.verificationEntries, [
    {
      title: "Docs",
      files: ["README.md"],
      commands: ["Review rendered Markdown and verify links if public-facing."],
    },
  ]);
  assert.deepEqual(packet.verificationEnvelope, {
    schemaVersion: "verify-by-change.v1",
    source: "/tmp/verification-envelope.json",
    verificationSource: "explicit_paths",
    entries: [
      {
        title: "Docs",
        files: ["README.md"],
        commands: ["Review rendered Markdown and verify links if public-facing."],
      },
    ],
  });
});

test("parseReviewPacketTaskContract extracts contract status and gaps", () => {
  const contract = parseReviewPacketTaskContract(`Source: \`/tmp/AGENT_TASK.md\`

- Status: \`warn\`
- Required sections: \`6/8\`
- Missing sections: Risks, Out of Scope
- Placeholder markers: Objective

\`\`\`md
# Agent Task
\`\`\`
`);

  assert.deepEqual(contract, {
    source: "/tmp/AGENT_TASK.md",
    status: "warn",
    requiredSections: "6/8",
    missingSections: ["Risks", "Out of Scope"],
    placeholderMarkers: ["Objective"],
  });
});

test("reviewPacketEvents imports passing task contracts as decisions", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`README.md\`

## Task Contract

Source: \`/tmp/AGENT_TASK.md\`

- Status: \`pass\`
- Required sections: \`8/8\`
- Missing sections: none
- Placeholder markers: none

\`\`\`md
# Agent Task
\`\`\`
`);

  const events = reviewPacketEvents(packet, {
    source: "/tmp/review-packet.md",
    link: "https://github.com/example/repo/commit/abc",
  });
  const summary = summarize(events);

  assert.equal(events.length, 2);
  assert.equal(events[1].type, "decision");
  assert.equal(events[1].title, "Task contract passed");
  assert.equal(events[1].status, "done");
  assert.deepEqual(events[1].files, ["/tmp/review-packet.md", "/tmp/AGENT_TASK.md"]);
  assert.deepEqual(events[1].links, ["https://github.com/example/repo/commit/abc"]);
  assert.match(events[1].summary, /Required sections: 8\/8/);
  assert.equal(summary.attention.length, 0);
});

test("reviewPacketEvents imports warning task contracts as blockers", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`README.md\`

## Task Contract

Source: \`/tmp/AGENT_TASK.md\`

- Status: \`warn\`
- Required sections: \`6/8\`
- Missing sections: Risks, Out of Scope
- Placeholder markers: Objective
`);

  const events = reviewPacketEvents(packet, {
    source: "/tmp/review-packet.md",
  });
  const summary = summarize(events);

  assert.equal(events.length, 2);
  assert.equal(events[1].type, "blocker");
  assert.equal(events[1].title, "Task contract needs attention");
  assert.equal(events[1].status, "blocked");
  assert.deepEqual(events[1].files, ["/tmp/review-packet.md", "/tmp/AGENT_TASK.md"]);
  assert.match(events[1].summary, /Missing sections: Risks, Out of Scope/);
  assert.match(events[1].summary, /Placeholder markers: Objective/);
  assert.equal(summary.attention.length, 1);
});

test("reviewPacketEvents turns review packet lanes and rendered envelopes into ledger evidence", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`README.md\`

## Review Map

### Product and docs

Focus: Check docs.

- \`README.md\`

## Repo Readiness

Source: \`/tmp/repo-readiness-contract.json\`

- Contract: \`repo-flightcheck.agent-contract.v1\`
- Ready: \`false\`
- Score: \`96/100\`
- Threshold: \`80\`
- Stack: \`node\`
- Summary: \`1\` required blockers, \`0\` recommendations, \`0\` critical failures.

Required before agent:

- \`WARN\` Working tree: Working tree has 1 changed path.

## Verification Checklist

Source: \`/tmp/verification-envelope.json\`
Envelope: \`verify-by-change.v1\`
Verification source: \`git, repo=/tmp/repo\`

\`\`\`md
# Verification Checklist

## Docs

- \`README.md\`

- Review rendered Markdown.
\`\`\`
`);

  const events = reviewPacketEvents(packet, {
    source: "/tmp/review-packet.md",
    command: "python3 codex_review_packet.py --repo .",
    link: "https://github.com/example/repo/commit/abc",
  });

  assert.equal(events.length, 5);
  assert.equal(events[0].type, "decision");
  assert.equal(events[0].status, "done");
  assert.equal(events[0].title, "Review packet: 1 changed file");
  assert.deepEqual(events[0].files, ["/tmp/review-packet.md", "README.md"]);
  assert.deepEqual(events[0].commands, ["python3 codex_review_packet.py --repo ."]);
  assert.deepEqual(events[0].links, ["https://github.com/example/repo/commit/abc"]);
  assert.equal(events[1].title, "Review lane: Product and docs");
  assert.equal(events[1].summary, "Check docs.");
  assert.equal(events[2].title, "Repo readiness: 96/100");
  assert.equal(events[2].status, "blocked");
  assert.equal(events[3].type, "blocker");
  assert.equal(events[3].status, "blocked");
  assert.equal(events[3].title, "Readiness warn: Working tree");
  assert.equal(events[4].type, "command");
  assert.equal(events[4].status, "planned");
  assert.equal(events[4].title, "Verify Docs");
  assert.match(events[4].summary, /verify-by-change\.v1 verification envelope/);
  assert.match(events[4].summary, /Verification source: git, repo=\/tmp\/repo/);
  assert.deepEqual(events[4].files, ["README.md", "/tmp/verification-envelope.json"]);
  assert.deepEqual(events[4].commands, ["Review rendered Markdown."]);
});

test("reviewPacketEvents imports embedded CI evidence from review packets", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`README.md\`

## Review Map

### Product and docs

Focus: Check docs.

- \`README.md\`

## CI Evidence

Source: \`/tmp/ci-run.json\`

- Run: \`26801172625\`
- Workflow: \`CI\`
- Status: \`completed\`
- Conclusion: \`success\`
- Branch: \`main\`
- SHA: \`25b526a9aa7e252d3da12fc26e10affb40bfc1cd\`
- Event: \`push\`
- URL: <https://github.com/example/repo/actions/runs/26801172625>
`);

  const events = reviewPacketEvents(packet, {
    source: "/tmp/review-packet.md",
    link: "https://github.com/example/repo/commit/25b526a",
  });

  assert.equal(events.length, 3);
  assert.equal(events[2].type, "command");
  assert.equal(events[2].title, "CI passed: CI");
  assert.equal(events[2].status, "passed");
  assert.deepEqual(events[2].files, ["/tmp/review-packet.md", "/tmp/ci-run.json"]);
  assert.deepEqual(events[2].commands, ["GitHub Actions: CI"]);
  assert.deepEqual(events[2].links, [
    "https://github.com/example/repo/actions/runs/26801172625",
    "https://github.com/example/repo/commit/25b526a",
  ]);
  assert.match(events[2].summary, /sha 25b526a9aa7e252d3da12fc26e10affb40bfc1cd/);
});

test("reviewPacketEvents imports passing published HEAD proof as command evidence", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`README.md\`

## Review Map

### Product and docs

Focus: Check docs.

- \`README.md\`

## Published HEAD

Source: \`/tmp/published-head.json\`

- Status: \`pass\`
- Message: Origin remote is reachable and local HEAD is published on origin/main.
- Schema: \`repo-flightcheck\`
- Branch: \`main\`
- Local HEAD: \`abc123\`
- Remote HEAD: \`abc123\`
- Commit URL: <https://github.com/example/repo/commit/abc123>

Evidence:
- \`origin/main: abc123\`
`);

  const events = reviewPacketEvents(packet, {
    source: "/tmp/review-packet.md",
  });
  const summary = summarize(events);

  assert.equal(events.length, 3);
  assert.equal(events[2].type, "command");
  assert.equal(events[2].title, "Published HEAD passed");
  assert.equal(events[2].status, "passed");
  assert.deepEqual(events[2].commands, ["Published HEAD proof"]);
  assert.deepEqual(events[2].files, ["/tmp/review-packet.md", "/tmp/published-head.json"]);
  assert.deepEqual(events[2].links, ["https://github.com/example/repo/commit/abc123"]);
  assert.match(events[2].summary, /schema repo-flightcheck/);
  assert.match(events[2].summary, /origin\/main: abc123/);
  assert.equal(summary.attention.length, 0);
});

test("reviewPacketEvents imports non-passing published HEAD proof as blocker", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`README.md\`

## Review Map

### Product and docs

Focus: Check docs.

- \`README.md\`

## Published HEAD

Source: \`/tmp/published-head.json\`

- Status: \`warn\`
- Message: Origin remote is reachable, but local HEAD is not published on origin/main.
- Schema: \`repo-flightcheck\`

Evidence:
- \`local HEAD: abc123\`
- \`origin/main: def456\`
`);

  const events = reviewPacketEvents(packet, {
    source: "/tmp/review-packet.md",
  });
  const summary = summarize(events);

  assert.equal(events.length, 3);
  assert.equal(events[2].type, "blocker");
  assert.equal(events[2].title, "Published HEAD blocked");
  assert.equal(events[2].status, "blocked");
  assert.deepEqual(events[2].commands, []);
  assert.deepEqual(events[2].files, ["/tmp/review-packet.md", "/tmp/published-head.json"]);
  assert.match(events[2].summary, /local HEAD is not published/);
  assert.equal(summary.attention.length, 1);
});

test("reviewPacketEvents imports sensitive change checks as blockers", () => {
  const packet = parseReviewPacket(`# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`.env\`
- \`permission_protocol/client.py\`

## Review Map

### Security and permissions

Focus: Check permission behavior and secret handling.

- \`permission_protocol/client.py\`

## Sensitive Change Check

These paths need explicit risk review before merge.

### Secret material

- \`.env\`

### Authorization and approval

- \`permission_protocol/client.py\`
`);

  const events = reviewPacketEvents(packet, {
    source: "/tmp/review-packet.md",
    link: "https://github.com/example/repo/commit/abc",
  });
  const summary = summarize(events);

  assert.equal(events.length, 4);
  assert.equal(events[2].type, "blocker");
  assert.equal(events[2].status, "blocked");
  assert.equal(events[2].title, "Sensitive change: Secret material");
  assert.deepEqual(events[2].files, ["/tmp/review-packet.md", ".env"]);
  assert.deepEqual(events[2].links, ["https://github.com/example/repo/commit/abc"]);
  assert.equal(events[3].title, "Sensitive change: Authorization and approval");
  assert.deepEqual(events[3].files, ["/tmp/review-packet.md", "permission_protocol/client.py"]);
  assert.equal(summary.attention.length, 2);
});

test("import-review-packet appends packet summary, review lane, and planned verification events", async () => {
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

## Repo Readiness

Source: \`/tmp/repo-readiness-contract.json\`

- Contract: \`repo-flightcheck.agent-contract.v1\`
- Ready: \`true\`
- Score: \`100/100\`
- Threshold: \`80\`
- Stack: \`node\`
- Summary: \`0\` required blockers, \`0\` recommendations, \`0\` critical failures.

No required blockers or recommendations.

## Verification Checklist

\`\`\`md
## Docs

- \`README.md\`

- Review rendered Markdown.

## Web

- \`src/app.js\`

- Run the closest frontend test/build command.
\`\`\`
`, "utf8");

    await runCli([
      "import-review-packet",
      "--ledger", ledgerPath,
      "--packet", packetPath,
      "--command", "python3 codex_review_packet.py --repo .",
    ]);
    const events = await readLedger(ledgerPath);
    const summary = summarize(events);

    assert.equal(events.length, 6);
    assert.equal(events[0].title, "Review packet: 2 changed files");
    assert.deepEqual(events.map((event) => event.type), ["decision", "decision", "decision", "command", "command", "command"]);
    assert.equal(events[3].title, "Repo readiness: 100/100");
    assert.equal(events[3].status, "passed");
    assert.deepEqual(events.slice(4).map((event) => event.status), ["planned", "planned"]);
    assert.ok(summary.files.includes(packetPath));
    assert.ok(summary.files.includes("src/app.js"));
    assert.equal(summary.commands[0].command, "python3 codex_review_packet.py --repo .");
    assert.equal(summary.openCommands.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("import-review-packet appends embedded task contract evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const packetPath = join(dir, "review-packet.md");
    await writeFile(packetPath, `# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`README.md\`

## Task Contract

Source: \`/tmp/AGENT_TASK.md\`

- Status: \`pass\`
- Required sections: \`8/8\`
- Missing sections: none
- Placeholder markers: none

\`\`\`md
# Agent Task
\`\`\`
`, "utf8");

    await runCli([
      "import-review-packet",
      "--ledger", ledgerPath,
      "--packet", packetPath,
    ]);
    const events = await readLedger(ledgerPath);
    const summary = summarize(events);

    assert.equal(events.length, 2);
    assert.equal(events[1].title, "Task contract passed");
    assert.equal(events[1].status, "done");
    assert.deepEqual(events[1].files, [packetPath, "/tmp/AGENT_TASK.md"]);
    assert.equal(summary.attention.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("import-review-packet appends embedded CI evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const packetPath = join(dir, "review-packet.md");
    await writeFile(packetPath, `# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`README.md\`

## Review Map

### Product and docs

Focus: Check docs.

- \`README.md\`

## CI Evidence

Source: \`/tmp/ci-run.json\`

- Run: \`26801172625\`
- Workflow: \`CI\`
- Status: \`completed\`
- Conclusion: \`success\`
- Branch: \`main\`
- SHA: \`25b526a9aa7e252d3da12fc26e10affb40bfc1cd\`
- Event: \`push\`
- URL: <https://github.com/example/repo/actions/runs/26801172625>
`, "utf8");

    await runCli([
      "import-review-packet",
      "--ledger", ledgerPath,
      "--packet", packetPath,
    ]);
    const events = await readLedger(ledgerPath);
    const summary = summarize(events);

    assert.equal(events.length, 3);
    assert.equal(events[2].title, "CI passed: CI");
    assert.equal(events[2].status, "passed");
    assert.deepEqual(events[2].files, [packetPath, "/tmp/ci-run.json"]);
    assert.equal(summary.commands.length, 1);
    assert.equal(summary.commands[0].status, "passed");
    assert.equal(summary.openCommands.length, 0);
    assert.equal(summary.attention.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("import-review-packet appends embedded published HEAD proof", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-test-"));

  try {
    const ledgerPath = join(dir, "ledger.jsonl");
    const packetPath = join(dir, "review-packet.md");
    await writeFile(packetPath, `# Review Packet

Repo: \`/tmp/repo\`
Base: \`origin/main\`

## Changed Files

- \`README.md\`

## Review Map

### Product and docs

Focus: Check docs.

- \`README.md\`

## Published HEAD

Source: \`/tmp/published-head.json\`

- Status: \`pass\`
- Message: Origin remote is reachable and local HEAD is published on origin/main.
- Schema: \`repo-flightcheck\`

Evidence:
- \`origin/main: abc123\`
`, "utf8");

    await runCli([
      "import-review-packet",
      "--ledger", ledgerPath,
      "--packet", packetPath,
    ]);
    const events = await readLedger(ledgerPath);
    const summary = summarize(events);

    assert.equal(events.length, 3);
    assert.equal(events[2].title, "Published HEAD passed");
    assert.equal(events[2].status, "passed");
    assert.equal(summary.commands.length, 1);
    assert.equal(summary.commands[0].command, "Published HEAD proof");
    assert.equal(summary.attention.length, 0);
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
