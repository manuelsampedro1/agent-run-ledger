import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export const EVENT_TYPES = new Set([
  "intent",
  "decision",
  "change",
  "command",
  "blocker",
  "result",
]);

export const STATUSES = new Set([
  "planned",
  "running",
  "passed",
  "failed",
  "blocked",
  "skipped",
  "done",
]);

export function createEvent(input, now = new Date()) {
  const type = input.type ?? "decision";
  const title = String(input.title ?? "").trim();
  const summary = String(input.summary ?? input.goal ?? "").trim();
  const status = input.status ? String(input.status).trim() : undefined;

  const event = {
    id: input.id ?? makeEventId(now, title),
    ts: input.ts ?? now.toISOString(),
    type,
    title,
    summary,
    files: toArray(input.files ?? input.file),
    commands: toArray(input.commands ?? input.command),
    links: toArray(input.links ?? input.link),
  };

  if (status) {
    event.status = status;
  }

  return event;
}

export function validateEvent(event, lineNumber = 0) {
  const prefix = lineNumber > 0 ? `line ${lineNumber}: ` : "";
  const errors = [];

  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return [`${prefix}event must be an object`];
  }

  for (const key of ["id", "ts", "type", "title", "summary"]) {
    if (typeof event[key] !== "string" || event[key].trim() === "") {
      errors.push(`${prefix}${key} is required`);
    }
  }

  if (event.type && !EVENT_TYPES.has(event.type)) {
    errors.push(`${prefix}type must be one of ${Array.from(EVENT_TYPES).join(", ")}`);
  }

  if (event.status && !STATUSES.has(event.status)) {
    errors.push(`${prefix}status must be one of ${Array.from(STATUSES).join(", ")}`);
  }

  if (requiresCommandStatus(event) && !event.status) {
    errors.push(`${prefix}status is required for command evidence`);
  }

  for (const key of ["files", "commands", "links"]) {
    if (event[key] !== undefined && !isStringArray(event[key])) {
      errors.push(`${prefix}${key} must be an array of strings`);
    }
  }

  if (event.ts && Number.isNaN(Date.parse(event.ts))) {
    errors.push(`${prefix}ts must be a valid ISO timestamp`);
  }

  return errors;
}

export async function appendEvent(ledgerPath, event) {
  const errors = validateEvent(event);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  await mkdir(dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, `${JSON.stringify(event)}\n`, "utf8");
}

export async function writeLedger(ledgerPath, events) {
  const lines = events.map((event, index) => {
    const errors = validateEvent(event, index + 1);
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
    return JSON.stringify(event);
  });

  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(ledgerPath, `${lines.join("\n")}\n`, "utf8");
}

export async function readLedger(ledgerPath) {
  const content = await readFile(ledgerPath, "utf8");
  const events = [];
  const errors = [];

  content.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === "") {
      return;
    }

    try {
      const event = JSON.parse(line);
      const eventErrors = validateEvent(event, index + 1);
      if (eventErrors.length > 0) {
        errors.push(...eventErrors);
      } else {
        events.push(event);
      }
    } catch (error) {
      errors.push(`line ${index + 1}: invalid JSON (${error.message})`);
    }
  });

  if (errors.length > 0) {
    const details = errors.map((error) => `- ${error}`).join("\n");
    throw new Error(`Ledger validation failed:\n${details}`);
  }

  return events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

export function summarize(events) {
  const byType = Object.fromEntries(Array.from(EVENT_TYPES, (type) => [type, 0]));
  const byStatus = Object.fromEntries(Array.from(STATUSES, (status) => [status, 0]));
  const files = new Set();
  const commands = [];
  const openCommands = [];
  const attention = [];

  for (const event of events) {
    byType[event.type] += 1;

    if (event.status) {
      byStatus[event.status] += 1;
    }

    for (const file of event.files ?? []) {
      files.add(file);
    }

    for (const command of event.commands ?? []) {
      const commandRecord = {
        command,
        status: event.status ?? "done",
        title: event.title,
      };
      commands.push(commandRecord);
      if (["planned", "running"].includes(commandRecord.status)) {
        openCommands.push(commandRecord);
      }
    }

    if (["failed", "blocked", "skipped"].includes(event.status) || event.type === "blocker") {
      attention.push(event);
    }
  }

  return {
    eventCount: events.length,
    byType,
    byStatus,
    files: Array.from(files).sort(),
    commands,
    openCommands,
    attention,
    startedAt: events[0]?.ts ?? null,
    finishedAt: events.at(-1)?.ts ?? null,
  };
}

export function demoEvents(now = new Date("2026-06-01T10:00:00.000Z")) {
  const base = now.getTime();
  const at = (minutes) => new Date(base + minutes * 60_000);

  return [
    createEvent({
      id: "evt_demo_001",
      ts: at(0).toISOString(),
      type: "intent",
      title: "Add billing webhook retry handling",
      summary: "Make webhook retries bounded, visible, and easy to review.",
      status: "planned",
      files: ["src/webhooks/billing.ts"],
    }),
    createEvent({
      id: "evt_demo_002",
      ts: at(8).toISOString(),
      type: "decision",
      title: "Keep retry state in the webhook module",
      summary: "The repo has no queue worker, so introducing one would expand scope without a current operational need.",
      files: ["src/webhooks/billing.ts", "DECISIONS.md"],
    }),
    createEvent({
      id: "evt_demo_003",
      ts: at(23).toISOString(),
      type: "change",
      title: "Add bounded retry classification",
      summary: "Network timeouts and 5xx responses now retry up to three times; validation errors fail immediately.",
      status: "done",
      files: ["src/webhooks/billing.ts", "test/webhooks/billing.test.ts"],
    }),
    createEvent({
      id: "evt_demo_004",
      ts: at(31).toISOString(),
      type: "command",
      title: "Run webhook tests",
      summary: "Targeted webhook regression tests passed locally.",
      status: "passed",
      commands: ["npm test -- webhooks"],
    }),
    createEvent({
      id: "evt_demo_005",
      ts: at(37).toISOString(),
      type: "result",
      title: "Ready for review",
      summary: "Review retry boundaries, provider idempotency assumptions, and the new failure-path tests first.",
      status: "done",
      links: ["https://github.com/example/repo/pull/42"],
    }),
  ];
}

function makeEventId(now, title) {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `evt_${stamp}_${slug || "note"}`;
}

function toArray(value) {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return [String(value).trim()].filter(Boolean);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requiresCommandStatus(event) {
  return event.type === "command" || (Array.isArray(event.commands) && event.commands.length > 0);
}
