import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((file) => !file.endsWith(".html"));

const failures = [];

for (const file of files) {
  const content = await readFile(file, "utf8");

  if (content.includes("\t")) {
    failures.push(`${file}: contains tab characters`);
  }

  if (!content.endsWith("\n")) {
    failures.push(`${file}: missing trailing newline`);
  }

  content.split(/\r?\n/).forEach((line, index) => {
    if (/\s+$/.test(line)) {
      failures.push(`${file}:${index + 1}: trailing whitespace`);
    }
  });
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Lint OK: ${files.length} files`);
}
