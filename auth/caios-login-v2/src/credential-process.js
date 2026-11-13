import { spawnSync } from "node:child_process";
import { failureDetails } from "./diagnostics.js";

const [cwic, ...args] = process.argv.slice(2);

try {
  const result = spawnSync(cwic, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
  // Never expose partial output from an interrupted or oversized response.
  if (result.error || result.signal) throw new Error();

  if (result.status !== 0 || result.stderr.trim()) {
    process.stderr.write(`${failureDetails(result.stderr, process.env)}\n`);
  }
  if (result.status === 0) process.stdout.write(result.stdout);
  process.exitCode = result.status ?? 1;
} catch {
  process.stderr.write("CWIC credential process could not complete.\n");
  process.exitCode = 1;
}
