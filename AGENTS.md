# AGENTS.md

## Purpose

Build and maintain a small local-first CLI for making AI agent runs auditable.

## Constraints

- Keep the package dependency-free unless a dependency removes clear maintenance risk.
- Preserve the JSONL ledger format as the stable handoff contract.
- Do not add SaaS sync, telemetry, API keys, or remote storage.
- Prefer readable Node standard library code over framework abstractions.
- Keep reports static HTML that can be opened from disk.

## Quality Bar

- Run `npm run lint`, `npm run build`, and `npm test` before closing meaningful changes.
- Add tests for parser, validation, summary, and report behavior when changing ledger semantics.
- Avoid fake scores and unverifiable benchmark claims.
- Keep README examples runnable.

## Product Bar

- The report should help a reviewer answer: what changed, why, what evidence exists, and what needs attention.
- Use concrete labels and compact sections. Avoid explaining generic AI benefits.
- Make failure and skipped verification visible.
