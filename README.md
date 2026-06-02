# agent-run-ledger

`agent-run-ledger` is a zero-dependency CLI for making AI agent work auditable.

It records an agent run as newline-delimited JSON, validates the entries, and renders a static HTML report that a teammate can review without opening the original chat transcript.

Use it when Codex, Claude Code, or another agent changes a repo and you want a compact record of:

- what the run was supposed to do
- which decisions were made
- which files changed
- which commands were run
- what passed, failed, or blocked the work
- what should be reviewed next

## Why this exists

Agent transcripts are useful while work is happening, but they are a poor handoff artifact. They are long, mixed with tool output, and hard to review after the fact.

This tool keeps a small, structured ledger beside the repo. The generated report is intentionally boring: timeline, evidence, changed files, command status, and review focus. No fake scores, no benchmark claims, no hidden service.

## Install

```bash
git clone git@github.com:manuelsampedro1/agent-run-ledger.git
cd agent-run-ledger
npm install
npm test
```

Run locally without publishing:

```bash
node bin/agent-run-ledger.js --help
```

## Quick Start

Create a demo ledger and report:

```bash
node bin/agent-run-ledger.js demo --out .agent-run
open .agent-run/report.html
```

Check a sample ledger and render a report:

```bash
node bin/agent-run-ledger.js doctor --ledger examples/sample-ledger.jsonl
node bin/agent-run-ledger.js doctor --ledger examples/sample-ledger.jsonl --json
node bin/agent-run-ledger.js report --ledger examples/sample-ledger.jsonl --out /tmp/agent-run-ledger-report.html
```

Expected CLI output:

```text
Ledger OK: 4 events
Files: 3
Commands: 2
Open commands: 0
Attention: 1
Wrote /tmp/agent-run-ledger-report.html
```

Machine-readable doctor output starts with:

```json
{
  "schema_version": "agent-run-ledger.doctor.v1",
  "ledger": "examples/sample-ledger.jsonl",
  "summary": {
    "eventCount": 4
  }
}
```

Import a verification checklist as planned command evidence. Markdown checklists and `verify-by-change --json-envelope` artifacts are both supported:

```bash
python3 /path/to/verify-by-change/verify_by_change.py --repo . --output /tmp/verification-checklist.md
node bin/agent-run-ledger.js import-checklist \
  --ledger .agent-run/ledger.jsonl \
  --checklist /tmp/verification-checklist.md

python3 /path/to/verify-by-change/verify_by_change.py --repo . --json-envelope --output /tmp/verification-envelope.json
node bin/agent-run-ledger.js import-checklist \
  --ledger .agent-run/ledger.jsonl \
  --checklist /tmp/verification-envelope.json
```

Use strict doctor mode when a handoff should fail until planned checks are executed and blockers are resolved:

```bash
node bin/agent-run-ledger.js doctor --ledger .agent-run/ledger.jsonl --strict
```

Record your own run:

```bash
node bin/agent-run-ledger.js start \
  --ledger .agent-run/ledger.jsonl \
  --goal "Add retry handling to the billing webhook"

node bin/agent-run-ledger.js note \
  --ledger .agent-run/ledger.jsonl \
  --type decision \
  --title "Keep retry state local" \
  --summary "The current repo has no queue worker, so the change stays in the webhook handler." \
  --file src/webhooks/billing.ts

node bin/agent-run-ledger.js note \
  --ledger .agent-run/ledger.jsonl \
  --type command \
  --title "Run webhook tests" \
  --summary "Webhook regression tests passed locally." \
  --command "npm test -- webhooks" \
  --status passed

node bin/agent-run-ledger.js report \
  --ledger .agent-run/ledger.jsonl \
  --out .agent-run/report.html
```

## Event Types

The CLI accepts these event types:

- `intent`: goal, scope, acceptance criteria
- `decision`: product, architecture, implementation, or review decisions
- `change`: meaningful file or behavior changes
- `command`: verification commands and outcomes
- `blocker`: anything that stopped or limited the run
- `result`: final outcome and next review focus

Statuses are optional except for command-like evidence. Events with `type: "command"` or any `commands` entries must include one of these statuses:

- `planned`
- `running`
- `passed`
- `failed`
- `blocked`
- `skipped`
- `done`

## Ledger Format

Each line is a JSON object:

```json
{"id":"evt_001","ts":"2026-06-01T10:00:00.000Z","type":"intent","title":"Ship retry handling","summary":"Add bounded retry handling to billing webhooks.","files":[],"commands":[],"status":"planned"}
```

Required fields:

- `id`
- `ts`
- `type`
- `title`
- `summary`

Optional fields:

- `files`: changed or relevant paths
- `commands`: shell commands used as evidence
- `status`: outcome marker; required for command events or events with `commands`
- `links`: related URLs or issue references

## Practical Workflow

1. Start a ledger before a non-trivial agent run.
2. Add a `decision` note whenever the agent chooses between two plausible paths.
3. Add a `change` note for each real behavior change, not every file touch.
4. Add a `command` note for every meaningful verification command.
5. End with a `result` note that says what a reviewer should inspect first.
6. Commit the ledger only when it helps future review; otherwise attach the HTML report to the handoff.

## Commands

```bash
agent-run-ledger start --ledger .agent-run/ledger.jsonl --goal "..."
agent-run-ledger note --ledger .agent-run/ledger.jsonl --type decision --title "..." --summary "..."
agent-run-ledger import-checklist --ledger .agent-run/ledger.jsonl --checklist /tmp/verification-checklist.md
agent-run-ledger import-checklist --ledger .agent-run/ledger.jsonl --checklist /tmp/verification-envelope.json
agent-run-ledger doctor --ledger .agent-run/ledger.jsonl
agent-run-ledger doctor --ledger .agent-run/ledger.jsonl --json
agent-run-ledger doctor --ledger .agent-run/ledger.jsonl --strict
agent-run-ledger report --ledger .agent-run/ledger.jsonl --out .agent-run/report.html
agent-run-ledger demo --out .agent-run
```

## Development

```bash
npm run lint
npm run build
npm test
```

The project uses only Node standard library APIs. That keeps the tool easy to inspect, fork, and run inside locked-down repos.
