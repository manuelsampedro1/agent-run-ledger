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
