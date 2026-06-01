import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.js";

const dir = await mkdtemp(join(tmpdir(), "agent-run-ledger-"));

try {
  await runCli(["demo", "--out", dir]);
  const report = await readFile(join(dir, "report.html"), "utf8");
  const ledger = await readFile(join(dir, "ledger.jsonl"), "utf8");

  if (!report.includes("Demo Agent Run Ledger")) {
    throw new Error("Generated report is missing its title");
  }

  if (ledger.trim().split("\n").length < 5) {
    throw new Error("Generated demo ledger is unexpectedly small");
  }

  console.log("Build OK: demo ledger and report generated");
} finally {
  await rm(dir, { recursive: true, force: true });
}
