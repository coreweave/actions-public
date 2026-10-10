import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { run } from "../src/cwcr-login.js";

async function fixture(
  t,
  { inputs = { registry: "acme.cwcr.io", audience: "cwcr-acme" } } = {},
) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "cwcr-login-test-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const calls = {
    failures: [],
    paths: [],
    execs: [],
    states: [],
  };
  const deps = {
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      RUNNER_TEMP: tempDir,
    },
    core: {
      getInput: (name, options) => {
        const value = inputs[name] ?? "";
        if (options?.required && !value)
          throw new Error(`Input required and not supplied: ${name}`);
        return value;
      },
      addPath: (value) => calls.paths.push(value),
      setFailed: (value) => calls.failures.push(value),
      saveState: (...args) => calls.states.push(args),
      info: () => {},
    },
    exec: {
      exec: async (command, args = []) => {
        calls.execs.push([command, ...args]);
        return 0;
      },
    },
    io: {
      which: async () => "/usr/local/bin/cwic",
    },
  };
  return { deps, calls, tempDir };
}

test("fails before running cwic when the job lacks OIDC access", async (t) => {
  const { deps, calls } = await fixture(t);
  deps.env = {};
  await run(deps);
  assert.equal(calls.failures.length, 1);
  assert.match(calls.failures[0], /id-token: write/);
  assert.deepEqual(calls.execs, []);
  assert.deepEqual(calls.paths, []);
});

test("fails before running cwic when cwic is not on PATH", async (t) => {
  const { deps, calls } = await fixture(t);
  deps.io.which = async () => "";
  await run(deps);
  assert.equal(calls.failures.length, 1);
  assert.match(calls.failures[0], /setup-cwic/);
  assert.deepEqual(calls.execs, []);
  assert.deepEqual(calls.paths, []);
  assert.deepEqual(calls.states, []);
});

test("installs the credential helper into a new directory and adds it to PATH", async (t) => {
  const { deps, calls, tempDir } = await fixture(t);
  await run(deps);
  assert.deepEqual(calls.failures, []);
  const [install] = calls.execs;
  assert.deepEqual(install.slice(0, 5), [
    "cwic",
    "registry",
    "credential-helper",
    "install",
    "--bin-dir",
  ]);
  const bin = install[5];
  assert.ok(bin.startsWith(tempDir + path.sep), `${bin} is under RUNNER_TEMP`);
  assert.ok((await stat(bin)).isDirectory());
  assert.deepEqual(calls.paths, [bin]);
});

test("uses a different helper directory on every run", async (t) => {
  const { deps, calls } = await fixture(t);
  await run(deps);
  await run(deps);
  assert.deepEqual(calls.failures, []);
  assert.equal(calls.paths.length, 2);
  assert.notEqual(calls.paths[0], calls.paths[1]);
});

test("fails before running cwic when the registry input is missing", async (t) => {
  const { deps, calls } = await fixture(t, {
    inputs: { registry: "", audience: "cwcr-acme" },
  });
  await run(deps);
  assert.equal(calls.failures.length, 1);
  assert.match(calls.failures[0], /registry/);
  assert.deepEqual(calls.execs, []);
  assert.deepEqual(calls.paths, []);
});

test("fails before running cwic when the audience input is missing", async (t) => {
  const { deps, calls } = await fixture(t, {
    inputs: { registry: "acme.cwcr.io", audience: "" },
  });
  await run(deps);
  assert.equal(calls.failures.length, 1);
  assert.match(calls.failures[0], /audience/);
  assert.deepEqual(calls.execs, []);
  assert.deepEqual(calls.paths, []);
});

test("configures the registry to fetch tokens with the bundled script", async (t) => {
  const { deps, calls } = await fixture(t);
  await run(deps);
  assert.deepEqual(calls.failures, []);
  assert.equal(calls.execs.length, 2);
  const [, configure] = calls.execs;
  assert.deepEqual(configure.slice(0, 7), [
    "cwic",
    "registry",
    "credential-helper",
    "configure",
    "acme.cwcr.io",
    "--oidc",
    "--",
  ]);
  const [node, script, audience, ...rest] = configure.slice(7);
  assert.equal(node, process.execPath);
  assert.ok(path.isAbsolute(script), `${script} is absolute`);
  assert.equal(path.basename(script), "token.cjs");
  assert.equal(audience, "cwcr-acme");
  assert.deepEqual(rest, []);
  assert.deepEqual(calls.states, [["registry", "acme.cwcr.io"]]);
});

// cwic throws an error if it can't find docker-credential-cwic on PATH when configure is called so ensure ordering
test("adds the helper directory to PATH before configuring", async (t) => {
  const { deps, calls } = await fixture(t);
  const record = deps.exec.exec;
  deps.exec.exec = async (command, args) => {
    if (args[2] === "configure") assert.equal(calls.paths.length, 1);
    return record(command, args);
  };
  await run(deps);
  assert.deepEqual(calls.failures, []);
});
