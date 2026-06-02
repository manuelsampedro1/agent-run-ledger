import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  appendEvent,
  createEvent,
  demoEvents,
  readLedger,
  summarize,
  writeLedger,
} from "./ledger.js";
import { renderReport } from "./report.js";

const HELP = `agent-run-ledger

Usage:
  agent-run-ledger start --ledger <path> --goal <text>
  agent-run-ledger note --ledger <path> --type <type> --title <text> --summary <text>
  agent-run-ledger import-checklist --ledger <path> --checklist <path> [--status planned]
  agent-run-ledger import-readiness --ledger <path> --readiness-report <path> [--command <cmd>]
  agent-run-ledger import-review-packet --ledger <path> --packet <path> [--command <cmd>]
  agent-run-ledger doctor --ledger <path> [--json] [--strict]
  agent-run-ledger report --ledger <path> --out <path>
  agent-run-ledger demo --out <dir>

Options:
  --file <path>       Add one referenced file. Repeatable.
  --command <cmd>     Add one verification command. Repeatable.
  --link <url>        Add one related link. Repeatable.
  --status <status>   planned, running, passed, failed, blocked, skipped, done
  --json              Print machine-readable JSON for supported commands.
  --strict            For doctor, set exit code 1 when evidence is still open or needs attention.
`;

export async function runCli(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);

  if (!command || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }

  if (command === "start") {
    requireOption(args, "ledger");
    requireOption(args, "goal");

    const event = createEvent({
      type: "intent",
      title: args.title ?? "Run started",
      summary: args.goal,
      status: args.status ?? "planned",
      files: args.file,
      commands: args.command,
      links: args.link,
    });

    await appendEvent(args.ledger, event);
    console.log(`Recorded start event in ${args.ledger}`);
    return;
  }

  if (command === "note") {
    requireOption(args, "ledger");
    requireOption(args, "title");
    requireOption(args, "summary");

    const event = createEvent({
      type: args.type,
      title: args.title,
      summary: args.summary,
      status: args.status,
      files: args.file,
      commands: args.command,
      links: args.link,
    });

    await appendEvent(args.ledger, event);
    console.log(`Recorded ${event.type} event in ${args.ledger}`);
    return;
  }

  if (command === "doctor") {
    requireOption(args, "ledger");
    const events = await readLedger(args.ledger);
    const summary = summarize(events);

    if (args.json) {
      console.log(JSON.stringify({
        schema_version: "agent-run-ledger.doctor.v1",
        ledger: args.ledger,
        summary,
      }, null, 2));
      if (args.strict && doctorNeedsAttention(summary)) {
        process.exitCode = 1;
      }
      return;
    }

    console.log(`Ledger OK: ${summary.eventCount} events`);
    console.log(`Files: ${summary.files.length}`);
    console.log(`Commands: ${summary.commands.length}`);
    console.log(`Open commands: ${summary.openCommands.length}`);
    console.log(`Attention: ${summary.attention.length}`);
    if (args.strict && doctorNeedsAttention(summary)) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "import-checklist") {
    requireOption(args, "ledger");
    requireOption(args, "checklist");

    const content = await readFile(args.checklist, "utf8");
    const entries = parseChecklistInput(content);
    const events = entries.map((entry) => createEvent({
      type: "command",
      title: `Verify ${entry.title}`,
      summary: `Imported verification checklist section from ${args.checklist}.`,
      status: args.status ?? "planned",
      files: entry.files,
      commands: entry.commands,
    }));

    for (const event of events) {
      await appendEvent(args.ledger, event);
    }

    console.log(`Imported ${events.length} verification event${events.length === 1 ? "" : "s"} into ${args.ledger}`);
    return;
  }

  if (command === "import-readiness") {
    requireOption(args, "ledger");
    requireOption(args, "readiness-report");

    const content = await readFile(args["readiness-report"], "utf8");
    const report = parseRepoReadinessReport(content);
    const events = readinessEventsFromReport(report, {
      source: args["readiness-report"],
      command: args.command,
      link: args.link,
      status: args.status,
    });

    for (const event of events) {
      await appendEvent(args.ledger, event);
    }

    console.log(`Imported repo readiness report as ${events.length} event${events.length === 1 ? "" : "s"} into ${args.ledger}`);
    return;
  }

  if (command === "import-review-packet") {
    requireOption(args, "ledger");
    requireOption(args, "packet");

    const content = await readFile(args.packet, "utf8");
    const packet = parseReviewPacket(content);
    const events = reviewPacketEvents(packet, {
      source: args.packet,
      command: args.command,
      link: args.link,
      status: args.status,
    });

    for (const event of events) {
      await appendEvent(args.ledger, event);
    }

    console.log(`Imported review packet as ${events.length} event${events.length === 1 ? "" : "s"} into ${args.ledger}`);
    return;
  }

  if (command === "report") {
    requireOption(args, "ledger");
    requireOption(args, "out");

    const events = await readLedger(args.ledger);
    const html = renderReport(events, { title: args.title ?? "Agent Run Ledger" });
    await mkdir(dirnameFor(args.out), { recursive: true });
    await writeFile(args.out, html, "utf8");
    console.log(`Wrote ${args.out}`);
    return;
  }

  if (command === "demo") {
    const outDir = args.out ?? ".agent-run";
    const ledgerPath = join(outDir, "ledger.jsonl");
    const reportPath = join(outDir, "report.html");
    const events = demoEvents();

    await mkdir(outDir, { recursive: true });
    await writeLedger(ledgerPath, events);
    await writeFile(reportPath, renderReport(events, { title: "Demo Agent Run Ledger" }), "utf8");
    console.log(`Wrote ${ledgerPath}`);
    console.log(`Wrote ${reportPath}`);
    return;
  }

  throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

export function parseChecklistInput(content) {
  const parsed = parseJsonVerificationEnvelope(content);
  if (parsed) {
    return parsed;
  }
  return parseVerificationChecklist(content);
}

export function parseJsonVerificationEnvelope(content) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }

  if (payload?.schema_version !== "verify-by-change.v1" || !payload.categories || typeof payload.categories !== "object") {
    return null;
  }

  return Object.entries(payload.categories)
    .map(([title, category]) => ({
      title: String(title),
      files: Array.isArray(category?.files) ? category.files.map(String) : [],
      commands: Array.isArray(category?.commands) ? category.commands.map(String) : [],
    }))
    .filter((entry) => entry.commands.length > 0);
}

export function parseVerificationChecklist(markdown) {
  const entries = [];
  let current = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = {
        title: heading[1].trim(),
        files: [],
        commands: [],
      };
      entries.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const bullet = line.match(/^-\s+(.+?)\s*$/);
    if (!bullet) {
      continue;
    }

    const value = bullet[1].trim();
    const file = value.match(/^`(.+?)`$/);
    if (file) {
      current.files.push(file[1]);
    } else {
      current.commands.push(value);
    }
  }

  return entries.filter((entry) => entry.commands.length > 0);
}

export function parseRepoReadinessReport(content) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid readiness JSON: ${error.message}`);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Readiness report must be a JSON object.");
  }

  const summary = payload.summary;
  const checks = payload.checks;
  if (!summary || typeof summary !== "object" || !Array.isArray(checks)) {
    throw new Error("Readiness report must include summary and checks.");
  }

  return {
    stack: String(payload.stack ?? "unknown"),
    summary: {
      score: numberOrDefault(summary.score, 0),
      pointsPossible: numberOrDefault(summary.pointsPossible, 100),
      passed: numberOrDefault(summary.passed, 0),
      warnings: numberOrDefault(summary.warnings, 0),
      failed: numberOrDefault(summary.failed, 0),
      criticalFailures: numberOrDefault(summary.criticalFailures, 0),
    },
    checks: checks.map((check) => ({
      title: String(check?.title ?? "Untitled readiness check"),
      status: String(check?.status ?? "unknown"),
      severity: String(check?.severity ?? "unknown"),
      message: String(check?.message ?? "No message."),
      fix: check?.fix ? String(check.fix) : "",
      evidence: Array.isArray(check?.evidence) ? check.evidence.map(String) : [],
    })),
    nextFixes: Array.isArray(payload.nextFixes) ? payload.nextFixes.map(String) : [],
  };
}

export function readinessEventsFromReport(report, options = {}) {
  const summary = report.summary;
  const nonPassing = report.checks.filter((check) => check.status !== "pass");
  const status = options.status ?? readinessStatus(summary);
  const source = options.source ?? "readiness report";
  const commands = options.command ?? [];
  const links = options.link ?? [];

  const summaryEvent = createEvent({
    type: "command",
    title: `Repo readiness: ${summary.score}/${summary.pointsPossible}`,
    summary: `Imported repo-flightcheck report from ${source}. ${summary.passed} passed, ${summary.warnings} warnings, ${summary.failed} failed, ${summary.criticalFailures} critical failures.`,
    status,
    files: readinessFiles(nonPassing, source),
    commands,
    links,
  });

  const attentionEvents = nonPassing.slice(0, 8).map((check) => createEvent({
    type: check.status === "fail" || check.severity === "critical" ? "blocker" : "decision",
    title: `Readiness ${check.status}: ${check.title}`,
    summary: `${check.message}${check.fix ? ` Fix: ${check.fix}` : ""}`,
    status: check.status === "fail" || check.severity === "critical" ? "blocked" : undefined,
    files: readinessFiles([check], source),
    links,
  }));

  return [summaryEvent, ...attentionEvents];
}

export function parseReviewPacket(content) {
  const repo = firstInlineCode(content.match(/^Repo:\s+(.+?)\s*$/m)?.[1] ?? "") ?? "";
  const base = firstInlineCode(content.match(/^Base:\s+(.+?)\s*$/m)?.[1] ?? "") ?? "";
  const changedSection = markdownSection(content, "Changed Files");
  const reviewMapSection = markdownSection(content, "Review Map");
  const changedFiles = inlineCodeBullets(changedSection);
  const lanes = parseReviewMap(reviewMapSection);

  return {
    repo,
    base,
    changedFiles,
    lanes,
  };
}

export function reviewPacketEvents(packet, options = {}) {
  const source = options.source ?? "review packet";
  const commands = options.command ?? [];
  const links = options.link ?? [];
  const status = options.status ?? "done";
  const packetFiles = [String(source), ...packet.changedFiles];

  const summaryEvent = createEvent({
    type: "decision",
    title: `Review packet: ${packet.changedFiles.length} changed file${packet.changedFiles.length === 1 ? "" : "s"}`,
    summary: `Imported codex-review-packet handoff from ${source}. Repo: ${packet.repo || "unknown"}. Base: ${packet.base || "unknown"}.`,
    status,
    files: packetFiles,
    commands,
    links,
  });

  const laneEvents = packet.lanes.map((lane) => createEvent({
    type: "decision",
    title: `Review lane: ${lane.title}`,
    summary: lane.focus || `Review ${lane.files.length} file${lane.files.length === 1 ? "" : "s"} in this lane.`,
    files: lane.files,
    links,
  }));

  return [summaryEvent, ...laneEvents];
}

export function doctorNeedsAttention(summary) {
  return summary.openCommands.length > 0 || summary.attention.length > 0;
}

export function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);

    if (key === "json") {
      args.json = true;
      continue;
    }

    if (key === "strict") {
      args.strict = true;
      continue;
    }

    const value = argv[index + 1];

    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    index += 1;

    if (["file", "command", "link"].includes(key)) {
      args[key] = [...(args[key] ?? []), value];
    } else {
      args[key] = value;
    }
  }

  return args;
}

function requireOption(args, key) {
  if (!args[key]) {
    throw new Error(`Missing required option --${key}`);
  }
}

function dirnameFor(path) {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "." : normalized.slice(0, index);
}

function readinessStatus(summary) {
  if (summary.criticalFailures > 0) {
    return "blocked";
  }
  if (summary.failed > 0) {
    return "failed";
  }
  if (summary.warnings > 0) {
    return "done";
  }
  return "passed";
}

function readinessFiles(checks, source) {
  const files = new Set([String(source)]);

  for (const check of checks) {
    for (const evidence of check.evidence ?? []) {
      const candidate = String(evidence).split(":", 1)[0].trim();
      if (looksLikeFile(candidate)) {
        files.add(candidate);
      }
    }
  }

  return Array.from(files);
}

function looksLikeFile(value) {
  return Boolean(value)
    && !value.startsWith("http")
    && !value.includes(" ")
    && (value.includes("/") || value.includes("\\") || value.includes("."));
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function markdownSection(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const selected = [];
  let inside = false;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      if (inside) {
        break;
      }
      inside = heading[1].trim() === title;
      continue;
    }

    if (inside) {
      selected.push(line);
    }
  }

  return selected.join("\n");
}

function parseReviewMap(section) {
  const lanes = [];
  let current = null;

  for (const line of section.split(/\r?\n/)) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      current = {
        title: heading[1].trim(),
        focus: "",
        files: [],
      };
      lanes.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    const focus = line.match(/^Focus:\s+(.+?)\s*$/);
    if (focus) {
      current.focus = focus[1].trim();
      continue;
    }

    const bullet = line.match(/^-\s+`(.+?)`\s*$/);
    if (bullet) {
      current.files.push(bullet[1]);
    }
  }

  return lanes.filter((lane) => lane.files.length > 0);
}

function inlineCodeBullets(section) {
  return section
    .split(/\r?\n/)
    .map((line) => line.match(/^-\s+`(.+?)`\s*$/)?.[1])
    .filter(Boolean);
}

function firstInlineCode(value) {
  return value.match(/`(.+?)`/)?.[1] ?? null;
}
