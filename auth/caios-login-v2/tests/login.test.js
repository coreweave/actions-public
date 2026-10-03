import assert from "node:assert/strict";
import { which } from "@actions/io";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  apiOrigin,
  cleanup,
  credentialCommand,
  run,
  tokenScript,
} from "../src/login.js";
import { withoutProfile } from "../src/profiles.js";

const execute = promisify(execFile);
const staticVariables = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
];
const webIdentityVariables = [
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_SESSION_NAME",
];

function credentials() {
  return {
    Version: 1,
    AccessKeyId: "private-access-key",
    SecretAccessKey: "private-secret-key",
    SessionToken: "private-session-token",
    Expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

async function fixture(t, inputs = {}, sharedEnv) {
  const root = await mkdtemp(path.join(tmpdir(), "caios login test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const temp = path.join(root, "runner temp");
  await mkdir(path.join(home, ".aws"), { recursive: true });
  await mkdir(temp);
  const env = sharedEnv || {
    RUNNER_TEMP: temp,
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-request-token",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/token?existing=value",
  };
  const values = {
    region: "US-EAST-04A",
    "org-id": "organization-id",
    ...inputs,
  };
  const state = {};
  const calls = {
    exports: [],
    failures: [],
    logs: [],
    secrets: [],
    warnings: [],
  };
  const toolkit = {
    getInput: (name) => values[name] || "",
    saveState: (name, value) => {
      state[name] = value;
    },
    getState: (name) => state[name] || "",
    exportVariable: (name, value) => {
      calls.exports.push([name, value]);
      env[name] = value;
    },
    setSecret: (value) => calls.secrets.push(value),
    setFailed: (message) => calls.failures.push(message),
    info: (message) => calls.logs.push(message),
    warning: (message) => calls.warnings.push(message),
  };
  const runner = {
    getExecOutput: t.mock.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify(credentials()),
      stderr: "",
    })),
  };
  const which = t.mock.fn(async (name) => `/tools with spaces/${name}`);
  return {
    root,
    temp,
    home,
    env,
    state,
    calls,
    deps: { toolkit, runner, which, env, home },
  };
}

async function missing(file) {
  await assert.rejects(stat(file), { code: "ENOENT" });
}

test("default login uses a private renewable process and removes overriding environment providers", async (t) => {
  const { deps, calls, env, home, state } = await fixture(t);
  // The action creates the default config directory when it does not exist.
  await rm(path.join(home, ".aws"), { recursive: true });
  for (const name of [...staticVariables, ...webIdentityVariables])
    env[name] = `old-${name}`;
  env.AWS_PROFILE = "inherited";
  env.AWS_DEFAULT_PROFILE = "inherited-default";
  await run(deps);

  assert.deepEqual(calls.failures, []);
  assert.equal(env.AWS_CONFIG_FILE, path.join(home, ".aws", "config"));
  const config = await readFile(env.AWS_CONFIG_FILE, "utf8");
  assert.match(
    config,
    /\[default\]\nregion = US-EAST-04A\nendpoint_url = https:\/\/cwobject\.com/,
  );
  assert.match(config, /s3 =\n    addressing_style = virtual/);
  assert.match(
    config,
    /credential_process = \/usr\/bin\/env "\/tools with spaces\/cwic" "auth" "accesskey" "oidc"/,
  );
  assert.match(config, /"--storage=disk"/);
  assert.match(config, /"--api-url" "https:\/\/api\.coreweave\.com"/);
  assert.match(config, /"--" ".*github-oidc\.sh"/);
  assert.equal(await readFile(env.AWS_SHARED_CREDENTIALS_FILE, "utf8"), "");
  for (const name of [...staticVariables, ...webIdentityVariables])
    assert.equal(env[name], "");
  assert.equal(env.AWS_PROFILE, "default");
  assert.equal(env.AWS_DEFAULT_PROFILE, "default");

  const authentication = deps.runner.getExecOutput.mock.calls[0].arguments;
  assert.equal(authentication[0], '"/tools with spaces/cwic"');
  assert.equal(authentication[2].silent, true);
  assert.equal(authentication[2].ignoreReturnCode, true);
  assert.equal(authentication[2].env, env);
  assert.equal(deps.runner.getExecOutput.mock.callCount(), 1);
  const helper = authentication[1].at(-1);
  const script = await readFile(helper, "utf8");
  assert.match(script, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/);
  assert.doesNotMatch(script, /private-request-token/);
  for (const [file, permissions] of [
    [state.workspace, 0o700],
    [helper, 0o700],
    [env.AWS_CONFIG_FILE, 0o600],
    [env.AWS_SHARED_CREDENTIALS_FILE, 0o600],
  ])
    assert.equal((await stat(file)).mode & 0o777, permissions);

  assert.deepEqual(calls.secrets, [
    "private-access-key",
    "private-secret-key",
    "private-session-token",
  ]);
  const published = JSON.stringify({ ...calls, secrets: undefined });
  for (const value of [...calls.secrets, "private-request-token"]) {
    assert.ok(!published.includes(value), `secret was exposed: ${value}`);
    assert.ok(
      !config.includes(value),
      `secret was written to the config: ${value}`,
    );
  }
});

for (const profile of ["default", "selected profile"]) {
  test(`${profile} replaces its whole profile, preserves other sections and leaves shared credentials unchanged`, async (t) => {
    const { deps, env, home, calls } = await fixture(t, { profile });
    const targetSection =
      profile === "default" ? "default" : `profile \"${profile}\"`;
    const otherProfile = profile === "default" ? "other" : "default";
    const otherSection =
      otherProfile === "default" ? "default" : `profile ${otherProfile}`;
    const retainedConfig = `# retained comment\n[${otherSection}]\nregion = retained-region\ncredential_process = original-provider\n[services shared]\ns3 =\n  endpoint_url = https://retained.example\n`;
    const oldConfig = `${retainedConfig}[${targetSection}]\naws_access_key_id = stale-key\nrole_arn = stale-role\nsso_session = stale-sso\nretry_mode = stale-retry\ns3 =\n    max_concurrent_requests = stale-concurrency\n`;
    const retainedCredentials = `# retained credentials comment\n[${otherProfile}]\naws_access_key_id = other-key\naws_secret_access_key = other-secret\n`;
    const oldCredentials = `${retainedCredentials}[${profile}]\naws_access_key_id = stale-key\naws_secret_access_key = stale-secret\n`;
    const sourceConfig = path.join(home, ".aws", "config");
    const sourceCredentials = path.join(home, ".aws", "credentials");
    await writeFile(sourceConfig, oldConfig);
    await writeFile(sourceCredentials, oldCredentials);
    await run(deps);

    assert.deepEqual(calls.failures, []);
    assert.equal(env.AWS_CONFIG_FILE, sourceConfig);
    assert.equal(await readFile(sourceCredentials, "utf8"), oldCredentials);
    const config = await readFile(env.AWS_CONFIG_FILE, "utf8");
    assert.ok(config.startsWith(retainedConfig));
    assert.doesNotMatch(
      config,
      /stale-key|stale-role|stale-sso|stale-retry|stale-concurrency/,
    );
    assert.ok(config.includes(`[${targetSection}]\nregion = US-EAST-04A`));
    assert.equal(
      await readFile(env.AWS_SHARED_CREDENTIALS_FILE, "utf8"),
      retainedCredentials,
    );
  });
}

test("named login honors config_file and custom shared credentials while preserving environment providers", async (t) => {
  const { deps, root, calls, env } = await fixture(t, {
    profile: "caios",
    "s3-endpoint": "https://objects.example",
    "oidc-endpoint":
      "https://api.example:8443/v1/cwobject/temporary-credentials/oidc/",
  });
  const configPath = path.join(root, "custom config");
  const getInput = deps.toolkit.getInput;
  deps.toolkit.getInput = (name) =>
    name === "config_file" ? configPath : getInput(name);
  const credentialsPath = path.join(root, "custom-credentials");
  await writeFile(configPath, "[profile source]\nregion = source-region\n");
  await writeFile(
    credentialsPath,
    "[source]\naws_access_key_id = source-key\n",
  );
  Object.assign(env, {
    AWS_CONFIG_FILE: configPath,
    AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
    AWS_PROFILE: "source",
    AWS_DEFAULT_PROFILE: "source",
  });
  for (const name of [...staticVariables, ...webIdentityVariables])
    env[name] = `original-${name}`;
  await run(deps);

  assert.deepEqual(calls.failures, []);
  assert.deepEqual(
    calls.exports.map(([name]) => name),
    ["AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"],
  );
  for (const name of [...staticVariables, ...webIdentityVariables])
    assert.equal(env[name], `original-${name}`);
  assert.equal(env.AWS_PROFILE, "source");
  assert.equal(env.AWS_DEFAULT_PROFILE, "source");
  assert.equal(env.AWS_CONFIG_FILE, configPath);
  const config = await readFile(env.AWS_CONFIG_FILE, "utf8");
  assert.match(config, /^\[profile source\]\nregion = source-region/);
  assert.match(config, /\[profile caios\]/);
  assert.match(config, /endpoint_url = https:\/\/objects\.example/);
  assert.match(config, /"--api-url" "https:\/\/api\.example:8443"/);
  assert.equal(
    await readFile(env.AWS_SHARED_CREDENTIALS_FILE, "utf8"),
    "[source]\naws_access_key_id = source-key\n",
  );
});

for (const requested of ["~/custom aws/config", "relative config/config"]) {
  test(`config_file resolves ${requested} and creates its parent directory`, async (t) => {
    const { deps, home, root, env, calls } = await fixture(t);
    // Keep the relative destination inside this test's temporary directory.
    const input = requested.startsWith("~/")
      ? requested
      : path.relative(process.cwd(), path.join(root, requested));
    const expected = requested.startsWith("~/")
      ? path.join(home, requested.slice(2))
      : path.resolve(input);
    const getInput = deps.toolkit.getInput;
    deps.toolkit.getInput = (name) =>
      name === "config_file" ? input : getInput(name);
    await run(deps);
    assert.deepEqual(calls.failures, []);
    assert.equal(env.AWS_CONFIG_FILE, expected);
    assert.match(await readFile(expected, "utf8"), /\[default\]/);
  });
}

test("the default destination is ~/.aws/config even when AWS_CONFIG_FILE is inherited", async (t) => {
  const { deps, root, home, env, calls } = await fixture(t);
  const inherited = path.join(root, "inherited-config");
  const original = "[profile inherited]\nregion = inherited-region\n";
  await writeFile(inherited, original);
  env.AWS_CONFIG_FILE = inherited;
  await run(deps);
  assert.deepEqual(calls.failures, []);
  assert.equal(env.AWS_CONFIG_FILE, path.join(home, ".aws", "config"));
  assert.equal(await readFile(inherited, "utf8"), original);
  assert.doesNotMatch(
    await readFile(env.AWS_CONFIG_FILE, "utf8"),
    /inherited-region/,
  );
});

for (const variable of [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "RUNNER_TEMP",
]) {
  test(`missing ${variable} fails before authentication or configuration changes`, async (t) => {
    const { deps, calls, temp, env } = await fixture(t);
    delete env[variable];
    await run(deps);
    assert.match(
      calls.failures[0],
      variable === "RUNNER_TEMP" ? /RUNNER_TEMP/ : /id-token: write/,
    );
    assert.equal(deps.runner.getExecOutput.mock.callCount(), 0);
    assert.deepEqual(calls.exports, []);
    assert.deepEqual(await readdir(temp), []);
  });
}

test("missing CWIC produces an actionable error before changing configuration", async (t) => {
  const { deps, calls, temp } = await fixture(t);
  deps.which = async () => {
    throw new Error("not found");
  };
  await run(deps);
  assert.match(calls.failures[0], /coreweave\/actions-public\/cwic\/setup-cwic/);
  assert.equal(deps.runner.getExecOutput.mock.callCount(), 0);
  assert.deepEqual(calls.exports, []);
  assert.deepEqual(await readdir(temp), []);
});

test("unsupported CWIC commands report their actual diagnostic without changing configuration", async (t) => {
  const { deps, calls, home, temp } = await fixture(t);
  const configFile = path.join(home, ".aws", "config");
  const original = "[default]\nregion = previous-region\n";
  await writeFile(configFile, original);
  deps.runner.getExecOutput = async () => ({
    exitCode: 1,
    stdout: "",
    stderr: "unknown subcommand oidc",
  });
  await run(deps);
  assert.match(calls.failures[0], /unknown subcommand oidc/);
  assert.equal(await readFile(configFile, "utf8"), original);
  assert.deepEqual(calls.exports, []);
  assert.deepEqual(await readdir(temp), []);
});

test("missing /usr/bin/env fails before authentication or configuration changes", async (t) => {
  const { deps, calls, temp } = await fixture(t);
  const originalWhich = deps.which;
  deps.which = async (name, required) => {
    if (name === "/usr/bin/env")
      throw new Error("Required executable /usr/bin/env was not found.");
    return originalWhich(name, required);
  };

  await run(deps);

  assert.match(calls.failures[0], /\/usr\/bin\/env/);
  assert.equal(deps.runner.getExecOutput.mock.callCount(), 0);
  assert.deepEqual(calls.exports, []);
  assert.deepEqual(await readdir(temp), []);
});

for (const endpoint of [
  "https://api.example/unsupported",
  "https://api.example/v1/cwobject/temporary-credentials/oidc?query=1",
  "https://api.example/v1/cwobject/temporary-credentials/oidc#fragment",
  "https://user:password@api.example/v1/cwobject/temporary-credentials/oidc",
  "file:///v1/cwobject/temporary-credentials/oidc",
  "invalid endpoint",
]) {
  test(`rejects unsupported OIDC endpoint ${endpoint}`, async (t) => {
    const { deps, calls, temp } = await fixture(t, {
      "oidc-endpoint": endpoint,
    });
    await run(deps);
    assert.equal(calls.failures.length, 1);
    assert.equal(deps.runner.getExecOutput.mock.callCount(), 0);
    assert.deepEqual(calls.exports, []);
    assert.deepEqual(await readdir(temp), []);
    assert.throws(() => apiOrigin(endpoint));
  });
}

for (const [input, value] of [
  ["profile", "bad[section]"],
  ["profile", 'bad"profile'],
  ["region", "region\ncredential_process = injected"],
  ["org-id", "org\0id"],
  ["audience", "audience\rvalue"],
  ["s3-endpoint", "https://objects.example\n[default]"],
  ["config_file", "config\nfile"],
]) {
  test(`rejects configuration injection in ${input}: ${JSON.stringify(value)}`, async (t) => {
    const { deps, calls } = await fixture(t, { [input]: value });
    await run(deps);
    assert.equal(calls.failures.length, 1);
    assert.equal(deps.runner.getExecOutput.mock.callCount(), 0);
    assert.deepEqual(calls.exports, []);
  });
}

for (const [name, response] of [
  ["expired", { ...credentials(), Expiration: "2000-01-01T00:00:00Z" }],
  ["without expiration", { ...credentials(), Expiration: undefined }],
  ["without a secret key", { ...credentials(), SecretAccessKey: undefined }],
  ["wrong process version", { ...credentials(), Version: 2 }],
]) {
  test(`rejects credentials ${name} and removes its helper`, async (t) => {
    const { deps, calls, temp, state } = await fixture(t);
    deps.runner.getExecOutput = async () => ({
      stdout: JSON.stringify(response),
      stderr: "",
      exitCode: 0,
    });
    await run(deps);
    assert.match(calls.failures[0], /valid, expiring AWS process credentials/);
    assert.deepEqual(calls.exports, []);
    assert.deepEqual(await readdir(temp), []);
    await missing(state.workspace);
  });
}

test("authentication failures leave the selected config and AWS environment untouched", async (t) => {
  const { deps, calls, temp, home, env, state } = await fixture(t);
  const configFile = path.join(home, ".aws", "config");
  const original = "[default]\nregion = previous-region\n";
  await writeFile(configFile, original);
  env.AWS_CONFIG_FILE = "/previous/config";
  deps.runner.getExecOutput = async () => {
    throw new Error("trust policy denied");
  };
  await run(deps);
  assert.match(calls.failures[0], /trust policy denied/);
  assert.deepEqual(calls.exports, []);
  assert.equal(env.AWS_CONFIG_FILE, "/previous/config");
  assert.equal(await readFile(configFile, "utf8"), original);
  assert.deepEqual(await readdir(temp), []);
  await missing(state.workspace);
  await cleanup(deps);
  assert.deepEqual(calls.exports, []);
  assert.deepEqual(calls.warnings, []);
});

test("failed CWIC authentication reports redacted stderr and never logs credential stdout", async (t) => {
  const { deps, calls, temp, env } = await fixture(t);
  env.AWS_SECRET_ACCESS_KEY = "inherited-secret";
  env.COREWEAVE_API_TOKEN = "inherited-api-token";
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJqb2IifQ.signature";
  deps.runner.getExecOutput = async () => ({
    exitCode: 1,
    stdout: JSON.stringify(credentials()),
    stderr: `Error: temporary-credentials API error [403]: permission denied\nrequest=${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}\njwt=${jwt}\n${env.AWS_SECRET_ACCESS_KEY} ${env.COREWEAVE_API_TOKEN}\n{"AccessKeyId":"echoed-key","SecretAccessKey":"secret with spaces","SessionToken":"echoed-session"}\nAuthorization: Bearer opaque-token\n`,
  });
  await run(deps);
  assert.equal(calls.failures.length, 1);
  assert.match(
    calls.failures[0],
    /CWIC OIDC authentication failed \(exit code 1\)/,
  );
  assert.match(calls.failures[0], /API error \[403\]: permission denied/);
  assert.match(calls.failures[0], /\[REDACTED\]/);
  const published = JSON.stringify({ ...calls, secrets: undefined });
  for (const secret of [
    "private-access-key",
    "private-secret-key",
    "private-session-token",
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    env.AWS_SECRET_ACCESS_KEY,
    env.COREWEAVE_API_TOKEN,
    jwt,
    "echoed-key",
    "secret with spaces",
    "echoed-session",
    "opaque-token",
  ])
    assert.ok(
      !published.includes(secret),
      "failure output must redact credentials",
    );
  assert.deepEqual(calls.exports, []);
  assert.deepEqual(await readdir(temp), []);
});

test("failed CWIC authentication with empty stderr reports the exit code without using stdout", async (t) => {
  const { deps, calls } = await fixture(t);
  deps.runner.getExecOutput = async () => ({
    exitCode: 2,
    stdout: "private-secret-key",
    stderr: "  \n",
  });
  await run(deps);
  assert.match(
    calls.failures[0],
    /exit code 2.*did not write diagnostics to stderr/,
  );
  assert.doesNotMatch(calls.failures[0], /private-secret-key/);
});

test("CWIC error details are bounded after redacting tokens", async (t) => {
  const { deps, calls } = await fixture(t);
  deps.runner.getExecOutput = async () => ({
    exitCode: 1,
    stdout: "",
    stderr: `Token: "${"s".repeat(5000)}"\n${"diagnostic ".repeat(1000)}`,
  });
  await run(deps);
  assert.match(calls.failures[0], /Token: \[REDACTED\]/);
  assert.ok(calls.failures[0].length < 4200);
});

test("malformed credential responses cannot leak their contents through failure messages", async (t) => {
  const { deps, calls, temp } = await fixture(t);
  deps.runner.getExecOutput = async () => ({
    stdout: "private-secret-key is not JSON",
    stderr: "",
    exitCode: 0,
  });
  await run(deps);
  assert.equal(calls.failures.length, 1);
  assert.doesNotMatch(
    JSON.stringify({ ...calls, secrets: undefined }),
    /private-secret-key/,
  );
  assert.deepEqual(calls.exports, []);
  assert.deepEqual(await readdir(temp), []);
});

for (const source of ["default", "custom"]) {
  test(`cleanup restores the ${source} shared credentials path and leaves configured settings in place`, async (t) => {
    const { deps, root, home, calls, env, state } = await fixture(t);
    const originalCredentials =
      source === "default"
        ? path.join(home, ".aws", "credentials")
        : path.join(root, "custom credentials");
    const originalContents =
      "[default]\naws_access_key_id = original-key\naws_secret_access_key = original-secret\n";
    await writeFile(originalCredentials, originalContents);
    if (source === "custom")
      env.AWS_SHARED_CREDENTIALS_FILE = originalCredentials;
    env.AWS_CONFIG_FILE = path.join(root, "previous-config");
    env.AWS_PROFILE = "inherited";
    env.AWS_DEFAULT_PROFILE = "inherited-default";
    for (const name of [...staticVariables, ...webIdentityVariables])
      env[name] = `inherited-${name}`;

    await run(deps);
    assert.deepEqual(calls.failures, []);
    const configuredFile = env.AWS_CONFIG_FILE;
    const configuredContents = await readFile(configuredFile, "utf8");
    calls.exports.length = 0;
    await cleanup(deps);

    assert.deepEqual(calls.warnings, []);
    assert.deepEqual(calls.exports, [
      ["AWS_SHARED_CREDENTIALS_FILE", originalCredentials],
    ]);
    assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, originalCredentials);
    assert.equal(await readFile(originalCredentials, "utf8"), originalContents);
    assert.equal(env.AWS_CONFIG_FILE, configuredFile);
    assert.equal(await readFile(configuredFile, "utf8"), configuredContents);
    assert.equal(env.AWS_PROFILE, "default");
    assert.equal(env.AWS_DEFAULT_PROFILE, "default");
    for (const name of [...staticVariables, ...webIdentityVariables])
      assert.equal(env[name], "");
    await missing(state.workspace);
  });
}

test("cleanup preserves a shared credentials path selected by a later step", async (t) => {
  const { deps, root, calls, env, state } = await fixture(t);
  await run(deps);
  assert.deepEqual(calls.failures, []);
  const replacementCredentials = path.join(root, "later-credentials");
  await writeFile(replacementCredentials, "preserve this file");
  env.AWS_SHARED_CREDENTIALS_FILE = replacementCredentials;
  calls.exports.length = 0;
  await cleanup(deps);

  assert.deepEqual(calls.warnings, []);
  assert.deepEqual(calls.exports, []);
  assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, replacementCredentials);
  assert.equal(
    await readFile(replacementCredentials, "utf8"),
    "preserve this file",
  );
  await missing(state.workspace);
});

test("consecutive invocations share the selected config and unwind temporary helpers in LIFO order", async (t) => {
  const first = await fixture(t, { profile: "first" });
  await run(first.deps);
  const firstConfig = first.env.AWS_CONFIG_FILE;
  const firstCredentials = first.env.AWS_SHARED_CREDENTIALS_FILE;
  const second = await fixture(
    t,
    { profile: "second", "org-id": "second-org" },
    first.env,
  );
  second.deps.home = first.home;
  await run(second.deps);
  assert.deepEqual(first.calls.failures, []);
  assert.deepEqual(second.calls.failures, []);
  assert.notEqual(second.state.workspace, first.state.workspace);
  assert.equal(firstConfig, first.env.AWS_CONFIG_FILE);
  const config = await readFile(first.env.AWS_CONFIG_FILE, "utf8");
  assert.match(config, /\[profile first\]/);
  assert.match(config, /\[profile second\]/);
  assert.ok(config.includes(first.state.workspace));
  assert.ok(config.includes(second.state.workspace));

  await cleanup(second.deps);
  await missing(second.state.workspace);
  assert.equal(first.env.AWS_CONFIG_FILE, firstConfig);
  assert.equal(first.env.AWS_SHARED_CREDENTIALS_FILE, firstCredentials);
  await stat(first.state.workspace);
  await cleanup(first.deps);
  await missing(first.state.workspace);
  assert.equal(
    first.env.AWS_CONFIG_FILE,
    path.join(first.home, ".aws", "config"),
  );
  assert.equal(
    first.env.AWS_SHARED_CREDENTIALS_FILE,
    path.join(first.home, ".aws", "credentials"),
  );
  assert.deepEqual(first.calls.warnings, []);
  assert.deepEqual(second.calls.warnings, []);
  assert.equal(await readFile(firstConfig, "utf8"), config);
});

test("cleanup with no saved state is harmless", async (t) => {
  const { deps, calls } = await fixture(t);
  await cleanup(deps);
  assert.deepEqual(calls.exports, []);
  assert.deepEqual(calls.warnings, []);
});

test("profile removal handles comments, CRLF, quoted profiles, and unrelated service sections", () => {
  const before = "# header\r\n[profile keep]\r\nregion = keep\r\n";
  const after =
    "[services target]\r\ns3 =\r\n endpoint_url = https://objects.example\r\n[profile keeper]\r\nregion = keeper";
  assert.equal(
    withoutProfile(
      `${before}[profile 'target'] # old\r\nrole_arn = old\r\n${after}`,
      "target",
      true,
    ),
    `${before}${after}`,
  );
  assert.equal(
    withoutProfile(
      "[default]\na = 1\n[target] ; old\na = 2\n[other]\na = 3",
      "target",
    ),
    "[default]\na = 1\n[other]\na = 3",
  );
  assert.equal(
    withoutProfile(
      "[services target]\ns3 =\n endpoint_url = retained\n",
      "services target",
      true,
    ),
    "[services target]\ns3 =\n endpoint_url = retained\n",
  );
});

test("credential command quotes spaces, quotes, and backslashes for AWS command parsers", () => {
  assert.equal(
    credentialCommand([
      "/path with spaces/cwic",
      "plain",
      'double"quote',
      "back\\slash",
      "single'quote",
    ]),
    '"/path with spaces/cwic" "plain" "double\\"quote" "back\\\\slash" "single\'quote"',
  );
});

test("credential command rejects shell interpolation and multiline arguments", () => {
  for (const value of [
    "$(touch marker)",
    "`touch marker`",
    "$SECRET",
    "first\nsecond",
    "first\rsecond",
    "first\0second",
  ]) {
    assert.throws(() => credentialCommand(["cwic", value]));
  }
});

async function oidcServer(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  return `http://127.0.0.1:${server.address().port}`;
}

async function scriptFixture(t, audience) {
  const root = await mkdtemp(path.join(tmpdir(), "caios token script-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = path.join(root, "github-oidc.sh");
  await writeFile(script, tokenScript(audience), { mode: 0o700 });
  const bin = path.join(root, "bin");
  await mkdir(bin);
  for (const program of ["sh", "curl", "sed"])
    await symlink(await which(program, true), path.join(bin, program));
  return { root, script, bin };
}

test("the generated POSIX sh helper fetches fresh tokens without Bash and safely encodes the audience", async (t) => {
  const requests = [];
  const base = await oidcServer(t, (request, response) => {
    requests.push({
      url: new URL(request.url, "http://localhost"),
      authorization: request.headers.authorization,
    });
    response.setHeader("Content-Type", "application/json");
    response.end(`{ "value" : "fresh-token-${requests.length}" }`);
  });
  const { root, script, bin } = await scriptFixture(t, "placeholder");
  const marker = path.join(root, "must-not-exist");
  const audience = `https://audience.example/a path?apostrophe='&injection=$(touch '${marker}')&more=\`touch '${marker}'\`#fragment`;
  await writeFile(script, tokenScript(audience));
  const executions = [
    [script, []],
    [script, []],
  ];
  const dash = await which("dash");
  if (dash) executions.push([dash, [script]]);
  for (const [index, [program, args]] of executions.entries()) {
    const number = index + 1;
    const result = await execute(program, args, {
      env: {
        PATH: bin,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: `request-secret-${number}`,
        ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/request-${number}?existing=retained`,
      },
      timeout: 10000,
    });
    assert.equal(result.stdout, `fresh-token-${number}\n`);
    assert.equal(result.stderr, "");
    assert.equal(
      requests[number - 1].authorization,
      `bearer request-secret-${number}`,
    );
    assert.equal(requests[number - 1].url.pathname, `/request-${number}`);
    assert.equal(
      requests[number - 1].url.searchParams.get("existing"),
      "retained",
    );
    assert.equal(
      requests[number - 1].url.searchParams.get("audience"),
      audience,
    );
    assert.equal(
      requests[number - 1].url.searchParams.getAll("audience").length,
      1,
    );
  }
  await missing(marker);
});

test("the generated POSIX sh helper rejects a curl failure even when curl emits a token", async (t) => {
  const { script, bin } = await scriptFixture(t, "https://coreweave.com/iam");
  const curl = path.join(bin, "curl");
  await rm(curl);
  await writeFile(
    curl,
    `#!/bin/sh
printf '%s\\n' '{"value":"must-not-be-returned"}'
exit 18
`,
    { mode: 0o700 },
  );
  for (const [name, program, args] of [
    ["executable helper", script, []],
    ["dash", await which("dash"), [script]],
  ]) {
    await t.test(name, { skip: !program }, async () => {
      await assert.rejects(
        execute(program, args, {
          env: {
            PATH: bin,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-request-token",
            ACTIONS_ID_TOKEN_REQUEST_URL: "https://github.example/token",
          },
          timeout: 10000,
        }),
        (error) => {
          assert.equal(error.code, 18);
          assert.equal(error.stdout, "");
          assert.doesNotMatch(
            error.stderr,
            /private-request-token|must-not-be-returned/,
          );
          return true;
        },
      );
    });
  }
});

for (const status of [429, 503]) {
  test(`the generated POSIX sh helper recovers from a transient HTTP ${status}`, async (t) => {
    let attempts = 0;
    const base = await oidcServer(t, (_, response) => {
      response.setHeader("Content-Type", "application/json");
      if (++attempts === 1) {
        response.writeHead(status).end('{"value":"must-not-be-returned"}');
      } else {
        response.end('{"value":"recovered-token"}');
      }
    });
    const { script, bin } = await scriptFixture(t, "https://coreweave.com/iam");
    const result = await execute(script, [], {
      env: {
        PATH: bin,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-request-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/token`,
      },
      timeout: 10000,
    });
    assert.equal(attempts, 2);
    assert.equal(result.stdout, "recovered-token\n");
    assert.doesNotMatch(
      result.stderr,
      /private-request-token|must-not-be-returned|recovered-token/,
    );
  });
}

test("the generated POSIX sh helper stops after three unsuccessful transient requests", async (t) => {
  let attempts = 0;
  const base = await oidcServer(t, (_, response) => {
    attempts++;
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end('{"value":"must-not-be-returned"}');
  });
  const { script, bin } = await scriptFixture(t, "https://coreweave.com/iam");
  await assert.rejects(
    execute(script, [], {
      env: {
        PATH: bin,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-request-token",
        ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/token`,
      },
      timeout: 10000,
    }),
    (error) => {
      assert.equal(error.code, 22);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /503/);
      assert.doesNotMatch(
        error.stderr,
        /private-request-token|must-not-be-returned/,
      );
      return true;
    },
  );
  assert.equal(attempts, 3);
});

for (const [name, status, body, errorPattern] of [
  ["missing value", 200, '{"message":"no token"}', /did not contain a token/],
  ["empty value", 200, '{"value":""}', /did not contain a token/],
  ["HTTP 401", 401, '{"value":"must-not-be-returned"}', /401/],
  ["HTTP 403", 403, '{"value":"must-not-be-returned"}', /403/],
]) {
  test(`the generated POSIX sh helper fails on ${name} without emitting credentials`, async (t) => {
    let attempts = 0;
    const base = await oidcServer(t, (_, response) => {
      attempts++;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(body);
    });
    const { script, bin } = await scriptFixture(t, "https://coreweave.com/iam");
    await assert.rejects(
      execute(script, [], {
        env: {
          PATH: bin,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-request-token",
          ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/token`,
        },
        timeout: 10000,
      }),
      (error) => {
        assert.notEqual(error.code, 0);
        assert.equal(error.stdout, "");
        assert.match(error.stderr, errorPattern);
        assert.doesNotMatch(
          error.stderr,
          /private-request-token|must-not-be-returned/,
        );
        return true;
      },
    );
    assert.equal(attempts, 1, "non-transient failures are not retried");
  });
}

for (const variable of [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
]) {
  test(`the generated POSIX sh helper diagnoses missing runtime ${variable}`, async (t) => {
    const { script, bin } = await scriptFixture(t, "https://coreweave.com/iam");
    const env = {
      PATH: bin,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1/should-not-be-requested",
    };
    delete env[variable];
    await assert.rejects(
      execute(script, [], { env, timeout: 10000 }),
      (error) => {
        assert.match(error.stderr, /id-token: write/);
        assert.equal(error.stdout, "");
        assert.doesNotMatch(error.stderr, /private-request-token/);
        return true;
      },
    );
  });
}
