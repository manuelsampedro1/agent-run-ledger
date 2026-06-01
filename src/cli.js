import { mkdir, writeFile } from "node:fs/promises";
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
  agent-run-ledger doctor --ledger <path>
  agent-run-ledger report --ledger <path> --out <path>
  agent-run-ledger demo --out <dir>

Options:
  --file <path>       Add one referenced file. Repeatable.
  --command <cmd>     Add one verification command. Repeatable.
  --link <url>        Add one related link. Repeatable.
  --status <status>   planned, running, passed, failed, blocked, skipped, done
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

    console.log(`Ledger OK: ${summary.eventCount} events`);
    console.log(`Files: ${summary.files.length}`);
    console.log(`Commands: ${summary.commands.length}`);
    console.log(`Attention: ${summary.attention.length}`);
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

export function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
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
