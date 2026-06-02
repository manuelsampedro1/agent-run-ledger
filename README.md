# agent-run-ledger

`agent-run-ledger` is a zero-dependency CLI for making AI agent work auditable.

It records an agent run as newline-delimited JSON, validates the entries, and renders a static HTML report that a teammate can review without opening the original chat transcript.

Use it when Codex, Claude Code, or another agent changes a repo and you want a compact record of:

- what the run was supposed to do
- which task contract bounded the work
- which decisions were made
- which files changed
- which commands were run
- which CI runs backed the closeout
- whether the reviewed local commit was actually published on the remote branch
- which sensitive paths still need explicit risk review
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

When the JSON envelope came from `verify-by-change --review-packet ... --json-envelope` and includes `repo_readiness`, the import also records that readiness summary as ledger evidence before the planned verification commands.

Import a repo readiness report before or after an agent run. This records a `repo-flightcheck --json` report or `repo-flightcheck --contract` artifact as ledger evidence and turns required or failed checks into blocker events:

```bash
node /path/to/repo-flightcheck/bin/repo-flightcheck.js . --json > /tmp/repo-readiness.json
node bin/agent-run-ledger.js import-readiness \
  --ledger .agent-run/ledger.jsonl \
  --readiness-report /tmp/repo-readiness.json \
  --command "node /path/to/repo-flightcheck/bin/repo-flightcheck.js . --json"

node /path/to/repo-flightcheck/bin/repo-flightcheck.js . --contract > /tmp/repo-readiness-contract.json
node bin/agent-run-ledger.js import-readiness \
  --ledger .agent-run/ledger.jsonl \
  --readiness-report /tmp/repo-readiness-contract.json \
  --command "node /path/to/repo-flightcheck/bin/repo-flightcheck.js . --contract"
```

Import a review packet after a Codex or Claude Code handoff. This records the packet, changed files, task contract, review lanes, sensitive-change checks, any embedded CI evidence, any embedded published-HEAD proof, any embedded repo readiness section, and any embedded verification checklist as ledger evidence:

```bash
python3 /path/to/codex-review-packet/codex_review_packet.py \
  --repo . \
  --verify-by-change /path/to/verify-by-change/verify_by_change.py \
  --output /tmp/review-packet.md

node bin/agent-run-ledger.js import-review-packet \
  --ledger .agent-run/ledger.jsonl \
  --packet /tmp/review-packet.md \
  --command "python3 /path/to/codex-review-packet/codex_review_packet.py --repo . --verify-by-change /path/to/verify-by-change/verify_by_change.py"
```

Review packet import can also carry the task contract rendered by `codex-review-packet`:

```bash
python3 /path/to/codex-review-packet/codex_review_packet.py \
  --repo . \
  --task-contract ./AGENT_TASK.md \
  --output /tmp/review-packet-with-task-contract.md

node bin/agent-run-ledger.js import-review-packet \
  --ledger .agent-run/ledger.jsonl \
  --packet /tmp/review-packet-with-task-contract.md
```

Review packet import can also carry public commit proof from `repo-flightcheck --check-remote --json`:

```bash
node /path/to/repo-flightcheck/bin/repo-flightcheck.js . --check-remote --json > /tmp/published-head.json

python3 /path/to/codex-review-packet/codex_review_packet.py \
  --repo . \
  --published-head /tmp/published-head.json \
  --output /tmp/review-packet-with-published-head.md

node bin/agent-run-ledger.js import-review-packet \
  --ledger .agent-run/ledger.jsonl \
  --packet /tmp/review-packet-with-published-head.md
```

Embedded task contracts are imported as `done` decision events when the packet says `Status: pass`; any other status is imported as a `blocked` blocker event so `doctor --strict` keeps the handoff open until missing task sections or placeholders are fixed.

Embedded sensitive-change checks are imported as `blocked` blocker events, so `doctor --strict` will keep the handoff open until a reviewer explicitly handles secret material, authorization or approval paths, and deploy or release paths.

Embedded CI evidence is imported as command evidence with `passed`, `failed`, `running`, `planned`, `skipped`, or `done` status. Embedded verification checks are imported as `planned` command events, so `doctor --strict` will keep the handoff open until those commands are recorded as passed, skipped, failed, or blocked.

Embedded published-HEAD proof is imported as passed command evidence when the packet says `Status: pass`; any other status is imported as a blocker so public proof cannot be treated as closed while the local commit is not on the remote branch.

When `codex-review-packet` renders a generated `verify-by-change.v1` envelope inside the packet, `agent-run-ledger` keeps the envelope schema and verification source in the imported command summaries instead of treating the checklist as anonymous Markdown.

Import GitHub Actions run evidence after a public push. Pass a JSON response from the GitHub Actions run API or the first item from a `workflow_runs` list response:

```bash
curl -fsS \
  https://api.github.com/repos/OWNER/REPO/actions/runs/RUN_ID \
  > /tmp/ci-run.json

node bin/agent-run-ledger.js import-ci \
  --ledger .agent-run/ledger.jsonl \
  --ci-run /tmp/ci-run.json \
  --command "GitHub Actions CI"
```

The imported CI run becomes command evidence with `passed`, `failed`, `running`, `planned`, `skipped`, or `done` status and carries the run URL when the JSON includes `html_url`.

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
agent-run-ledger import-readiness --ledger .agent-run/ledger.jsonl --readiness-report /tmp/repo-readiness.json
agent-run-ledger import-review-packet --ledger .agent-run/ledger.jsonl --packet /tmp/review-packet.md
agent-run-ledger import-ci --ledger .agent-run/ledger.jsonl --ci-run /tmp/ci-run.json
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
