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
  agent-run-ledger import-ci --ledger <path> --ci-run <path> [--command <cmd>]
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

const REVIEW_PACKET_SECTIONS = new Set([
  "Changed Files",
  "Review Map",
  "Repo Context",
  "Repo Readiness",
  "Diff",
  "Verification Checklist",
  "Suggested Review Prompt",
]);

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
    const readinessEvents = readinessEventsFromVerificationEnvelope(content, {
      source: args.checklist,
      link: args.link,
    });
    const verificationEvents = entries.map((entry) => createEvent({
      type: "command",
      title: `Verify ${entry.title}`,
      summary: `Imported verification checklist section from ${args.checklist}.`,
      status: args.status ?? "planned",
      files: entry.files,
      commands: entry.commands,
    }));
    const events = [...readinessEvents, ...verificationEvents];

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

  if (command === "import-ci") {
    requireOption(args, "ledger");
    requireOption(args, "ci-run");

    const content = await readFile(args["ci-run"], "utf8");
    const run = parseGitHubActionsRun(content);
    const event = ciRunEvent(run, {
      source: args["ci-run"],
      command: args.command,
      link: args.link,
    });

    await appendEvent(args.ledger, event);
    console.log(`Imported CI run evidence into ${args.ledger}`);
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
  const payload = parseJsonVerificationEnvelopePayload(content);
  if (!payload) {
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

export function parseJsonVerificationEnvelopePayload(content) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }

  if (payload?.schema_version !== "verify-by-change.v1" || !payload.categories || typeof payload.categories !== "object") {
    return null;
  }

  return payload;
}

export function parseVerificationEnvelopeReadiness(content) {
  const payload = parseJsonVerificationEnvelopePayload(content);
  const readiness = payload?.repo_readiness;
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    return null;
  }

  return normalizeVerificationEnvelopeReadiness(readiness);
}

export function readinessEventsFromVerificationEnvelope(content, options = {}) {
  const report = parseVerificationEnvelopeReadiness(content);
  if (!report) {
    return [];
  }

  return readinessEventsFromReport(report, options);
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
  if (payload.schemaVersion === "repo-flightcheck.agent-contract.v1") {
    return normalizeReadinessContract(payload);
  }
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
      requiredBlockers: numberOrDefault(summary.requiredBlockers, 0),
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

export function parseGitHubActionsRun(content) {
  let payload;
  try {
    payload = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid CI run JSON: ${error.message}`);
  }

  if (payload?.workflow_runs && Array.isArray(payload.workflow_runs)) {
    payload = payload.workflow_runs[0];
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("CI run report must be a JSON object.");
  }

  const id = payload.id ?? payload.run_id;
  const name = payload.name ?? payload.workflow_name;
  const status = payload.status;
  const conclusion = payload.conclusion;

  if (!id || !name || !status) {
    throw new Error("CI run report must include id, name, and status.");
  }

  return {
    id: String(id),
    name: String(name),
    status: String(status),
    conclusion: conclusion === null || conclusion === undefined ? null : String(conclusion),
    htmlUrl: payload.html_url ? String(payload.html_url) : "",
    headSha: payload.head_sha ? String(payload.head_sha) : "",
    headBranch: payload.head_branch ? String(payload.head_branch) : "",
    event: payload.event ? String(payload.event) : "",
  };
}

export function ciRunEvent(run, options = {}) {
  const source = options.source ?? "CI run report";
  const commands = options.command?.length ? options.command : [`GitHub Actions: ${run.name}`];
  const links = uniqueStrings([run.htmlUrl, ...(options.link ?? [])].filter(Boolean));
  const detail = [
    `status ${run.status}`,
    run.conclusion ? `conclusion ${run.conclusion}` : null,
    run.headBranch ? `branch ${run.headBranch}` : null,
    run.headSha ? `sha ${run.headSha}` : null,
  ].filter(Boolean).join(", ");

  return createEvent({
    type: "command",
    title: `CI ${ciRunStatus(run)}: ${run.name}`,
    summary: `Imported GitHub Actions run ${run.id} from ${source}: ${detail}.`,
    status: ciRunStatus(run),
    files: [String(source)],
    commands,
    links,
  });
}

function ciRunStatus(run) {
  if (run.status !== "completed") {
    return run.status === "queued" || run.status === "requested" || run.status === "pending" ? "planned" : "running";
  }

  if (run.conclusion === "success") {
    return "passed";
  }
  if (run.conclusion === "skipped" || run.conclusion === "cancelled") {
    return "skipped";
  }
  if (["failure", "timed_out", "startup_failure", "action_required"].includes(run.conclusion)) {
    return "failed";
  }
  return "done";
}

function normalizeReadinessContract(payload) {
  const required = Array.isArray(payload.requiredBeforeAgent)
    ? payload.requiredBeforeAgent.map((check) => normalizeReadinessCheck(check, true))
    : [];
  const recommended = Array.isArray(payload.recommendedBeforeAgent)
    ? payload.recommendedBeforeAgent.map((check) => normalizeReadinessCheck(check, false))
    : [];

  return {
    stack: String(payload.stack ?? "unknown"),
    summary: {
      score: numberOrDefault(payload.score, 0),
      pointsPossible: 100,
      passed: payload.ready ? 1 : 0,
      warnings: recommended.length,
      failed: required.length,
      criticalFailures: numberOrDefault(
        payload.criticalFailures,
        required.filter((check) => check.severity === "critical").length,
      ),
      requiredBlockers: required.length,
    },
    checks: [...required, ...recommended],
    nextFixes: Array.isArray(payload.nextFixes) ? payload.nextFixes.map(String) : [],
  };
}

function normalizeVerificationEnvelopeReadiness(readiness) {
  const requiredBlockers = optionalNumber(readiness.required_blockers, readiness.ready === false ? 1 : 0);
  const criticalFailures = optionalNumber(readiness.critical_failures, 0);
  const failed = optionalNumber(readiness.failed, requiredBlockers);
  const recommendations = optionalNumber(readiness.recommendations, 0);
  const warnings = optionalNumber(readiness.warnings, recommendations);

  return {
    stack: String(readiness.stack ?? "unknown"),
    summary: {
      score: optionalNumber(readiness.score, 0),
      pointsPossible: optionalNumber(readiness.points_possible, 100),
      passed: optionalNumber(readiness.passed, readiness.ready === true ? 1 : 0),
      warnings,
      failed,
      criticalFailures,
      requiredBlockers,
    },
    checks: [],
    nextFixes: [],
  };
}

function normalizeReadinessCheck(check, required) {
  return {
    title: String(check?.title ?? "Untitled readiness check"),
    status: String(check?.status ?? "unknown"),
    severity: String(check?.severity ?? "unknown"),
    message: String(check?.message ?? "No message."),
    fix: check?.fix ? String(check.fix) : "",
    evidence: Array.isArray(check?.evidence) ? check.evidence.map(String) : [],
    required,
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
    summary: `Imported repo-flightcheck report from ${source}. ${summary.passed} passed, ${summary.warnings} warnings, ${summary.failed} failed, ${summary.criticalFailures} critical failures${summary.requiredBlockers ? `, ${summary.requiredBlockers} required blockers` : ""}.`,
    status,
    files: readinessFiles(nonPassing, source),
    commands,
    links,
  });

  const attentionEvents = nonPassing.slice(0, 8).map((check) => createEvent({
    type: readinessCheckBlocks(check) ? "blocker" : "decision",
    title: `Readiness ${check.status}: ${check.title}`,
    summary: `${check.message}${check.fix ? ` Fix: ${check.fix}` : ""}`,
    status: readinessCheckBlocks(check) ? "blocked" : undefined,
    files: readinessFiles([check], source),
    links,
  }));

  return [summaryEvent, ...attentionEvents];
}

export function parseReviewPacketReadiness(section) {
  if (!section.trim()) {
    return null;
  }

  const contract = markdownInlineMetric(section, "Contract");
  const ready = markdownBoolMetric(section, "Ready");
  const [score, pointsPossible] = markdownScoreMetric(markdownInlineMetric(section, "Score"));
  const summaryText = markdownSummaryLine(section);
  const requiredBlockers = markdownLabeledCount(summaryText, "required blockers");
  const recommendations = markdownLabeledCount(summaryText, "recommendations");
  const passed = markdownLabeledCount(summaryText, "passed");
  const warnings = markdownLabeledCount(summaryText, "warnings");
  const failed = markdownLabeledCount(summaryText, "failed");
  const criticalFailures = markdownLabeledCount(summaryText, "critical failures");

  return {
    stack: markdownInlineMetric(section, "Stack") ?? "unknown",
    summary: {
      score: optionalNumber(score, 0),
      pointsPossible: optionalNumber(pointsPossible, 100),
      passed: optionalNumber(passed, ready === true ? 1 : 0),
      warnings: optionalNumber(warnings, optionalNumber(recommendations, 0)),
      failed: optionalNumber(failed, optionalNumber(requiredBlockers, 0)),
      criticalFailures: optionalNumber(criticalFailures, 0),
      requiredBlockers: optionalNumber(requiredBlockers, 0),
    },
    checks: parseReviewPacketReadinessChecks(section, Boolean(contract)),
    nextFixes: parseReviewPacketNextFixes(section),
  };
}

export function parseReviewPacket(content) {
  const repo = firstInlineCode(content.match(/^Repo:\s+(.+?)\s*$/m)?.[1] ?? "") ?? "";
  const base = firstInlineCode(content.match(/^Base:\s+(.+?)\s*$/m)?.[1] ?? "") ?? "";
  const changedSection = markdownSection(content, "Changed Files");
  const reviewMapSection = markdownSection(content, "Review Map");
  const readinessSection = markdownSection(content, "Repo Readiness");
  const verificationSection = markdownSection(content, "Verification Checklist");
  const changedFiles = inlineCodeBullets(changedSection);
  const lanes = parseReviewMap(reviewMapSection);
  const readinessReport = parseReviewPacketReadiness(readinessSection);
  const verificationEntries = parseChecklistInput(verificationSection);

  return {
    repo,
    base,
    changedFiles,
    lanes,
    readinessReport,
    verificationEntries,
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

  const readinessEvents = packet.readinessReport
    ? readinessEventsFromReport(packet.readinessReport, {
      source,
      link: links,
    })
    : [];

  const verificationEvents = (packet.verificationEntries ?? []).map((entry) => createEvent({
    type: "command",
    title: `Verify ${entry.title}`,
    summary: `Imported embedded verification checklist section from ${source}.`,
    status: "planned",
    files: entry.files,
    commands: entry.commands,
    links,
  }));

  return [summaryEvent, ...laneEvents, ...readinessEvents, ...verificationEvents];
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
  if (summary.requiredBlockers > 0) {
    return "blocked";
  }
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

function readinessCheckBlocks(check) {
  return check.required || check.status === "fail" || check.severity === "critical";
}

function readinessFiles(checks, source) {
  const files = new Set([String(source)]);

  for (const check of checks) {
    for (const evidence of check.evidence ?? []) {
      const candidate = readinessEvidenceFileCandidate(evidence);
      if (looksLikeFile(candidate)) {
        files.add(candidate);
      }
    }
  }

  return Array.from(files);
}

function readinessEvidenceFileCandidate(evidence) {
  const raw = String(evidence).split(":", 1)[0].trim();
  const gitStatus = raw.match(/^[ MADRCU?!]{1,2}\s+(.+)$/);
  return gitStatus ? gitStatus[1].trim() : raw;
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

function optionalNumber(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  return numberOrDefault(value, fallback);
}

function uniqueStrings(values) {
  return Array.from(new Set(values.map(String).filter(Boolean)));
}

function markdownSection(markdown, title) {
  const lines = markdown.split(/\r?\n/);
  const headings = [];

  lines.forEach((line, index) => {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    const packetSection = heading?.[1]?.trim();
    if (packetSection && REVIEW_PACKET_SECTIONS.has(packetSection)) {
      headings.push({ title: packetSection, index });
    }
  });

  const candidates = headings.filter((heading) => heading.title === title);
  if (candidates.length === 0) {
    return "";
  }

  const selected = title === "Verification Checklist" ? candidates.at(-1) : candidates[0];
  const end = headings.find((heading) => heading.index > selected.index)?.index ?? lines.length;
  return lines.slice(selected.index + 1, end).join("\n");
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

function parseReviewPacketReadinessChecks(section, contract) {
  const checks = [];
  let currentRequired = false;

  for (const line of section.split(/\r?\n/)) {
    if (/^Required before agent:\s*$/.test(line)) {
      currentRequired = true;
      continue;
    }
    if (/^(Recommended before agent:|Attention checks:)\s*$/.test(line)) {
      currentRequired = false;
      continue;
    }

    const match = line.match(/^-\s+`([A-Z.]+)`\s+(.+?):\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }

    checks.push({
      title: match[2].trim(),
      status: match[1].toLowerCase(),
      severity: "unknown",
      message: match[3].trim(),
      fix: "",
      evidence: [],
      required: contract ? currentRequired : false,
    });
  }

  return checks;
}

function parseReviewPacketNextFixes(section) {
  const fixes = [];
  let inside = false;
  let sawFix = false;

  for (const line of section.split(/\r?\n/)) {
    if (/^Next fixes:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && line.trim() === "" && sawFix) {
      break;
    }
    if (!inside) {
      continue;
    }

    const bullet = line.match(/^-\s+(.+?)\s*$/);
    if (bullet && !bullet[1].startsWith("`...`")) {
      fixes.push(bullet[1].trim());
      sawFix = true;
    }
  }

  return fixes;
}

function markdownInlineMetric(markdown, label) {
  return markdown.match(new RegExp(`^- ${escapeRegExp(label)}: \`([^\`]+)\``, "m"))?.[1] ?? null;
}

function markdownBoolMetric(markdown, label) {
  const value = markdownInlineMetric(markdown, label);
  if (value === null) {
    return null;
  }
  if (value.toLowerCase() === "true") {
    return true;
  }
  if (value.toLowerCase() === "false") {
    return false;
  }
  return null;
}

function markdownScoreMetric(value) {
  if (!value) {
    return [null, null];
  }
  const [score, pointsPossible] = value.split("/", 2);
  return [score, pointsPossible ?? null];
}

function markdownSummaryLine(markdown) {
  return markdown.match(/^- Summary: (.+?)\s*$/m)?.[1] ?? "";
}

function markdownLabeledCount(summary, label) {
  const match = summary.match(new RegExp(`\`?(\\d+)\`?\\s+${escapeRegExp(label)}`));
  return match ? Number(match[1]) : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
