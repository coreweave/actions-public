import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanup } from "../src/cleanup.js";

function fixture({ registry = "acme.cwcr.io" } = {}) {
  const calls = { failures: [], warnings: [], execs: [] };
  const deps = {
    core: {
      getState: (name) => (name === "registry" ? registry : ""),
      setFailed: (value) => calls.failures.push(value),
      warning: (value) => calls.warnings.push(value),
    },
    exec: {
      exec: async (command, args = []) => {
        calls.execs.push([command, ...args]);
        return 0;
      },
    },
  };
  return { deps, calls };
}

test("removes the credential helper binding saved by the main step", async () => {
  const { deps, calls } = fixture();
  await cleanup(deps);
  assert.deepEqual(calls.execs, [
    ["cwic", "registry", "credential-helper", "unconfigure", "acme.cwcr.io"],
  ]);
  assert.deepEqual(calls.failures, []);
  assert.deepEqual(calls.warnings, []);
});

test("does nothing when the main step did not configure a registry", async () => {
  const { deps, calls } = fixture({ registry: "" });
  await cleanup(deps);
  assert.deepEqual(calls.execs, []);
  assert.deepEqual(calls.failures, []);
  assert.deepEqual(calls.warnings, []);
});

test("warns instead of failing the job when unconfigure fails", async () => {
  const { deps, calls } = fixture();
  deps.exec.exec = async () => {
    throw new Error("unknown command");
  };
  await cleanup(deps);
  assert.equal(calls.warnings.length, 1);
  assert.match(calls.warnings[0], /unknown command/);
  assert.deepEqual(calls.failures, []);
});
