import assert from "node:assert/strict";
import { which } from "@actions/io";
import { execFile } from "node:child_process";
import { once } from "node:events";
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
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { run as configureLogin } from "../src/login.js";

const execute = promisify(execFile);
const actionRoot = fileURLToPath(new URL("../", import.meta.url));
const enabled = process.env.CWIC_INTEGRATION === "1";

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function isolatedEnv(overrides) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(AWS_|INPUT_|STATE_|GITHUB_)/.test(name)) delete env[name];
  }
  return Object.assign(env, overrides);
}

async function serve(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

// Keep subprocess output captured: credential_process prints credentials, and
// the action emits masking commands that must not become integration-test logs.
async function run(program, args, options = {}) {
  try {
    return await execute(program, args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      ...options,
    });
  } catch (error) {
    throw new Error(
      `${path.basename(program)} failed (${error.code ?? "unknown exit"}); check integration prerequisites and rebuild dist before running.`,
    );
  }
}

async function readCommands(file) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  const values = {};
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const header = /^([^=]+)<<(.+)$/.exec(lines[i]);
    assert.ok(header, "expected a GitHub file-command delimiter");
    const body = [];
    while (++i < lines.length && lines[i] !== header[2]) body.push(lines[i]);
    assert.ok(
      i < lines.length,
      "GitHub file command has its closing delimiter",
    );
    values[header[1]] = body.join("\n");
  }
  return values;
}

async function cacheEntries(directory) {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) {
      entries.push(...(await cacheEntries(file)));
    } else if (item.isFile()) {
      let value;
      try {
        value = JSON.parse(await readFile(file, "utf8"));
      } catch {
        continue; // CWIC also keeps non-JSON coordination lock files here.
      }
      if (value.output?.Version === 1) entries.push({ file, value });
    }
  }
  return entries;
}

function fakeJWT(generation) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ sub: "integration", generation })}.integration-signature`;
}

test(
  "bundled action reports CWIC authentication failures without leaking tokens",
  { skip: !enabled, timeout: 30_000 },
  async (t) => {
    await run("cwic", ["version"]);

    for (const failure of ["exchange", "github"]) {
      await t.test(`${failure} endpoint rejection`, async (t) => {
        const fixture = await temporaryDirectory(t, "caios failure integration ");
        const runnerTemp = path.join(fixture, "runner temp");
        await mkdir(runnerTemp);
        const requestBearer = "integration-failure-request-bearer";
        const jwt = fakeJWT(403);
        const credentials = {
          AccessKeyId: "integration-failure-access-key",
          SecretAccessKey: "integration-failure-secret-key",
          SessionToken: "integration-failure-session-token",
        };
        const tokenRequests = [];
        const exchanges = [];
        const unexpectedRequests = [];
        const origin = await serve(t, (request, response) => {
          const url = new URL(request.url, "http://localhost");
          response.setHeader("Content-Type", "application/json");
          if (url.pathname === "/github/oidc") {
            tokenRequests.push(request.headers.authorization);
            if (failure === "github") {
              response.writeHead(503).end(
                JSON.stringify({ error: "GitHub OIDC temporarily unavailable" }),
              );
            } else {
              response.end(JSON.stringify({ value: jwt }));
            }
          } else if (
            url.pathname ===
            "/v1/cwobject/temporary-credentials/oidc/cw-integration"
          ) {
            exchanges.push(request.headers.authorization);
            // Exercise CWIC's real error formatting, including an upstream
            // response that echoes sensitive values in its diagnostic body.
            response.writeHead(403).end(
              JSON.stringify({
                error: `Permission denied for integration trust policy: ${jwt}; ${requestBearer}`,
                ...credentials,
              }),
            );
          } else {
            unexpectedRequests.push(url.pathname);
            response.writeHead(404).end("{}");
          }
        });
        const envFile = path.join(fixture, "github-env");
        const stateFile = path.join(fixture, "github-state");
        await writeFile(envFile, "");
        await writeFile(stateFile, "");
        const env = isolatedEnv({
          RUNNER_TEMP: runnerTemp,
          GITHUB_ENV: envFile,
          GITHUB_STATE: stateFile,
          AWS_CONFIG_FILE: path.join(fixture, "unused-config"),
          AWS_SHARED_CREDENTIALS_FILE: path.join(fixture, "unused-credentials"),
          ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/github/oidc?api-version=2.0`,
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestBearer,
          INPUT_REGION: "US-EAST-04A",
          "INPUT_ORG-ID": "cw-integration",
          INPUT_PROFILE: "caios",
          INPUT_CONFIG_FILE: path.join(fixture, "action config"),
          INPUT_AUDIENCE: "https://coreweave.com/iam",
          "INPUT_OIDC-ENDPOINT": `${origin}/v1/cwobject/temporary-credentials/oidc`,
          "INPUT_S3-ENDPOINT": origin,
        });

        // This invocation is expected to fail. Capture its output locally;
        // do not attach execFile's error (which includes output) to a failure.
        let result;
        try {
          result = {
            exitCode: 0,
            ...(await execute(
              process.execPath,
              [path.join(actionRoot, "dist/index.js")],
              { env, cwd: fixture, encoding: "utf8", timeout: 10_000 },
            )),
          };
        } catch (error) {
          if (typeof error.code !== "number")
            throw new Error("Bundled action did not complete normally.");
          result = {
            exitCode: error.code,
            stdout: error.stdout,
            stderr: error.stderr,
          };
        }
        assert.equal(result.exitCode, 1);
        const log = `${result.stdout}\n${result.stderr}`;
        for (const secret of [requestBearer, jwt, ...Object.values(credentials)])
          assert.ok(!log.includes(secret), "action logs must not expose secrets");
        assert.ok(log.includes("CAIOS login failed:"));
        assert.ok(
          log.includes(`exit code ${failure === "exchange" ? 1 : 22}`),
          "failure identifies CWIC's exit",
        );
        if (failure === "exchange") {
          assert.ok(log.includes("403"), "failure includes the API status");
          assert.ok(
            log.includes("Permission denied for integration trust policy"),
            "failure includes the API diagnostic",
          );
          assert.ok(exchanges[0] === jwt, "CWIC exchanges the GitHub token");
        } else {
          assert.ok(log.includes("curl:"), "failure identifies the token helper");
          assert.ok(log.includes("503"), "failure includes GitHub's HTTP status");
        }
        assert.equal(tokenRequests.length, failure === "exchange" ? 1 : 3);
        assert.ok(
          tokenRequests.every(
            (authorization) => authorization === `bearer ${requestBearer}`,
          ),
        );
        assert.equal(exchanges.length, failure === "exchange" ? 1 : 0);
        assert.equal(unexpectedRequests.length, 0);
        assert.equal(await readFile(envFile, "utf8"), "");
        await assert.rejects(stat(env.INPUT_CONFIG_FILE), { code: "ENOENT" });
        const state = await readCommands(stateFile);
        assert.equal(path.dirname(state.workspace), runnerTemp);
        await assert.rejects(stat(state.workspace), { code: "ENOENT" });
      });
    }
  },
);

test(
  "bundled action refreshes CWIC credentials through the AWS CLI and Go SDK",
  {
    skip: enabled
      ? false
      : "set CWIC_INTEGRATION=1; requires CWIC, AWS CLI v2, Go, POSIX sh, curl, and sed on PATH",
    timeout: 180_000,
  },
  async (t) => {
    await run("cwic", ["version"]);
    await run("aws", ["--version"]);
    const cwic = await which("cwic", true);
    const buildDirectory = await temporaryDirectory(t, "caios go sdk ");
    const goCredentials = path.join(buildDirectory, "go-credentials");
    await run("go", ["build", "-mod=readonly", "-o", goCredentials, "."], {
      cwd: path.join(actionRoot, "tests/go-credentials"),
      timeout: 120_000,
    });

    for (const profile of ["default", "caios"]) {
      await t.test(
        `${profile} profile caches, refreshes, and cleans up`,
        async (t) => {
          const fixture = await temporaryDirectory(t, "caios integration ");
          const runnerTemp = path.join(fixture, "runner temp");
          const laterCwd = path.join(fixture, "another working directory");
          const binDirectory = path.join(fixture, "cwic bin");
          await mkdir(runnerTemp);
          await mkdir(laterCwd);
          await mkdir(binDirectory);
          const cwicPath = path.join(binDirectory, "cwic");
          await symlink(cwic, cwicPath);

          const audience =
            "https://coreweave.com/iam?workflow=build & scope=read";
          const orgId = "cw-integration";
          const tokenRequests = [];
          const exchanges = [];
          let s3Requests = 0;
          const unexpectedRequests = [];
          const keys = ["integration-first-key", "integration-renewed-key"];
          const secrets = [
            "integration-first-secret",
            "integration-renewed-secret",
          ];
          const sessions = [
            "integration-first-session",
            "integration-renewed-session",
          ];
          const requestBearers = [
            "integration-first-request",
            "integration-renewed-request",
          ];
          const origin = await serve(t, (request, response) => {
            const url = new URL(request.url, "http://localhost");
            response.setHeader("Content-Type", "application/json");
            if (url.pathname === "/github/oidc") {
              const generation = tokenRequests.length;
              tokenRequests.push({
                authorization: request.headers.authorization,
                audience: url.searchParams.get("audience"),
                apiVersion: url.searchParams.get("api-version"),
              });
              response.end(
                JSON.stringify({ value: fakeJWT(generation) }, null, 2),
              );
            } else if (
              url.pathname ===
              `/v1/cwobject/temporary-credentials/oidc/${orgId}`
            ) {
              const generation = exchanges.length;
              exchanges.push(request.headers.authorization);
              response.end(
                JSON.stringify({
                  AccessKeyId: keys[generation],
                  SecretAccessKey: secrets[generation],
                  Token: sessions[generation],
                  Expiration: new Date(Date.now() + 30 * 60_000).toISOString(),
                }),
              );
            } else if (url.pathname === "/" && request.method === "GET") {
              s3Requests++;
              response.setHeader("Content-Type", "application/xml");
              response.end(
                '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets/></ListAllMyBucketsResult>',
              );
            } else {
              unexpectedRequests.push(url.pathname);
              response.writeHead(404).end("{}");
            }
          });

          const sourceConfig = path.join(fixture, "original config");
          const inheritedConfig = path.join(fixture, "inherited config");
          const sourceCredentials = path.join(fixture, "original credentials");
          const configText = `[${profile === "default" ? "default" : `profile ${profile}`}]
region = old-region
endpoint_url = https://obsolete.example
credential_process = /must-not-run
role_arn = arn:aws:iam::123456789012:role/must-not-assume
source_profile = unrelated
sso_session = obsolete-sso
retry_mode = adaptive
max_attempts = 7
services = retained-services
s3 =
    addressing_style = path
    use_accelerate_endpoint = true
    max_concurrent_requests = 14
    multipart_threshold = 128MB

[profile unrelated]
region = preserve-me
services = retained-services

[services retained-services]
s3 =
    endpoint_url = http://127.0.0.1:9/must-not-use
sts =
    endpoint_url = https://retained-sts.example
`;
          const credentialsText = `[${profile}]
aws_access_key_id = obsolete-key
aws_secret_access_key = obsolete-secret

[unrelated]
aws_access_key_id = unrelated-key
aws_secret_access_key = unrelated-secret
`;
          await writeFile(sourceConfig, configText);
          await writeFile(inheritedConfig, "[default]\nregion = untouched\n");
          await writeFile(sourceCredentials, credentialsText);
          const envFile = path.join(fixture, "github-env");
          const stateFile = path.join(fixture, "github-state");
          const outputFile = path.join(fixture, "github-output");
          const cleanupEnvFile = path.join(fixture, "cleanup-env");
          for (const file of [envFile, stateFile, outputFile, cleanupEnvFile])
            await writeFile(file, "");

          // Isolate AWS and GitHub settings without changing HOME or touching the
          // runner's real AWS files. CWIC uses its supported per-action cache dir.
          const env = isolatedEnv({
            PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
            RUNNER_TEMP: runnerTemp,
            GITHUB_ENV: envFile,
            GITHUB_STATE: stateFile,
            GITHUB_OUTPUT: outputFile,
            AWS_CONFIG_FILE: inheritedConfig,
            AWS_SHARED_CREDENTIALS_FILE: sourceCredentials,
            AWS_EC2_METADATA_DISABLED: "true",
            AWS_CLI_AUTO_PROMPT: "off",
            AWS_PAGER: "",
            ACTIONS_ID_TOKEN_REQUEST_URL: `${origin}/github/oidc?api-version=2.0`,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestBearers[0],
            INPUT_REGION: "US-EAST-04A",
            "INPUT_ORG-ID": orgId,
            INPUT_PROFILE: profile === "default" ? "" : profile,
            INPUT_CONFIG_FILE: sourceConfig,
            INPUT_AUDIENCE: audience,
            "INPUT_OIDC-ENDPOINT": `${origin}/v1/cwobject/temporary-credentials/oidc`,
            "INPUT_S3-ENDPOINT": origin,
          });
          if (profile === "default") {
            env.AWS_ACCESS_KEY_ID = "obsolete-environment-key";
            env.AWS_SECRET_ACCESS_KEY = "obsolete-environment-secret";
            env.AWS_SESSION_TOKEN = "obsolete-environment-session";
            env.AWS_SECURITY_TOKEN = "obsolete-environment-security-token";
            env.AWS_ROLE_ARN = "arn:aws:iam::123456789012:role/must-not-use";
            env.AWS_WEB_IDENTITY_TOKEN_FILE = path.join(
              fixture,
              "must-not-read-web-identity-token",
            );
            env.AWS_ROLE_SESSION_NAME = "inherited-session";
          }

          await run(
            process.execPath,
            [path.join(actionRoot, "dist/index.js")],
            { env, cwd: fixture },
          );
          assert.equal(
            tokenRequests.length,
            1,
            "login obtains the first GitHub OIDC token",
          );
          assert.equal(exchanges.length, 1, "login exchanges the token once");
          const exported = await readCommands(envFile);
          const state = await readCommands(stateFile);
          if (profile === "default") {
            for (const name of [
              "AWS_ROLE_ARN",
              "AWS_WEB_IDENTITY_TOKEN_FILE",
              "AWS_ROLE_SESSION_NAME",
            ])
              assert.equal(
                exported[name],
                "",
                `${name} cannot override the CAIOS credential process`,
              );
          }
          assert.equal(path.dirname(state.workspace), runnerTemp);
          assert.equal(exported.AWS_CONFIG_FILE, sourceConfig);
          assert.equal(
            exported.AWS_SHARED_CREDENTIALS_FILE,
            path.join(state.workspace, "credentials"),
          );
          assert.match(
            await readFile(exported.AWS_CONFIG_FILE, "utf8"),
            /\[profile unrelated\]\nregion = preserve-me/,
          );
          assert.match(
            await readFile(exported.AWS_SHARED_CREDENTIALS_FILE, "utf8"),
            /\[unrelated\]\naws_access_key_id = unrelated-key/,
          );

          const useEnv = { ...env, ...exported };
          if (profile !== "default") useEnv.AWS_PROFILE = profile;
          for (const [setting, expected] of [
            ["region", "US-EAST-04A"],
            ["endpoint_url", origin],
            ["s3.addressing_style", "virtual"],
          ]) {
            assert.equal(
              (
                await run("aws", ["configure", "get", setting], {
                  env: useEnv,
                  cwd: laterCwd,
                })
              ).stdout.trim(),
              expected,
              `AWS reads ${setting} from the configured profile`,
            );
          }
          const configured = await readFile(exported.AWS_CONFIG_FILE, "utf8");
          assert.doesNotMatch(
            configured,
            /obsolete|must-not-assume|must-not-run|retry_mode|max_attempts|max_concurrent_requests|multipart_threshold|use_accelerate_endpoint/,
            "the selected profile is replaced, including its non-auth settings",
          );
          assert.ok(
            configured.includes(cwicPath),
            "credential_process quotes a CWIC executable path containing spaces",
          );
          assert.ok(
            configured.includes(
              "[profile unrelated]\nregion = preserve-me\nservices = retained-services",
            ),
            "another profile keeps using its original services section",
          );
          assert.ok(
            configured.includes(
              "[services retained-services]\ns3 =\n    endpoint_url = http://127.0.0.1:9/must-not-use\nsts =\n    endpoint_url = https://retained-sts.example",
            ),
            "the shared services section remains unchanged",
          );
          await run("aws", ["s3api", "list-buckets", "--no-sign-request"], {
            env: useEnv,
            cwd: laterCwd,
          });
          assert.equal(
            s3Requests,
            1,
            "AWS uses the action's S3 endpoint instead of the inherited service endpoint",
          );
          const awsArgs = [
            "configure",
            "export-credentials",
            "--format",
            "process",
          ];
          const clients = [
            { name: "AWS CLI", program: "aws", args: awsArgs },
            { name: "Go SDK", program: goCredentials, args: [] },
          ];
          for (const client of clients) {
            const first = JSON.parse(
              (
                await run(client.program, client.args, {
                  env: useEnv,
                  cwd: laterCwd,
                })
              ).stdout,
            );
            assert.ok(
              first.AccessKeyId === keys[0],
              `${client.name} resolves the first CWIC access key`,
            );
            assert.ok(
              first.SecretAccessKey === secrets[0],
              `${client.name} resolves the first CWIC secret`,
            );
            assert.ok(
              first.SessionToken === sessions[0],
              `${client.name} resolves the first CWIC session token`,
            );
          }
          const presigned = await run(
            "aws",
            ["s3", "presign", "s3://integration-bucket/example"],
            { env: useEnv, cwd: laterCwd },
          );
          assert.ok(
            presigned.stdout.startsWith(`${origin}/`),
            "S3 object requests use the configured endpoint without Accelerate",
          );
          assert.equal(
            tokenRequests.length,
            1,
            "fresh cached credentials do not request another JWT",
          );
          assert.equal(
            exchanges.length,
            1,
            "fresh cached credentials avoid another exchange",
          );

          // Advance only this invocation's cache past expiry instead of waiting
          // for the real 30-minute lifetime or relying on a mocked CWIC binary.
          const entries = await cacheEntries(
            path.join(state.workspace, "cache"),
          );
          assert.equal(
            entries.length,
            1,
            "CWIC writes one isolated credential cache entry",
          );
          const expired = new Date(Date.now() - 60_000).toISOString();
          entries[0].value.output.Expiration = expired;
          entries[0].value.real_expiration = expired;
          entries[0].value.fetched_at = new Date(
            Date.now() - 60 * 60_000,
          ).toISOString();
          await writeFile(entries[0].file, JSON.stringify(entries[0].value));
          useEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN = requestBearers[1];
          // Each client triggers renewal in one profile; the other then reads
          // the refreshed CWIC cache through its own config loader.
          const renewingClients =
            profile === "default" ? clients : [...clients].reverse();
          for (const client of renewingClients) {
            const args =
              client.program === "aws"
                ? [...client.args, "--profile", profile]
                : client.args;
            const renewed = JSON.parse(
              (
                await run(client.program, args, {
                  env: useEnv,
                  cwd: laterCwd,
                })
              ).stdout,
            );
            assert.ok(
              renewed.AccessKeyId === keys[1],
              `${client.name} resolves the renewed CWIC access key`,
            );
            assert.ok(
              renewed.SecretAccessKey === secrets[1],
              `${client.name} resolves the renewed CWIC secret`,
            );
            assert.ok(
              renewed.SessionToken === sessions[1],
              `${client.name} resolves the renewed CWIC session token`,
            );
            assert.ok(
              Date.parse(renewed.Expiration) > Date.now(),
              `${client.name} resolves credentials with a future expiration`,
            );
          }
          assert.equal(
            tokenRequests.length,
            2,
            "expiry requests a new GitHub OIDC token",
          );
          assert.equal(
            exchanges.length,
            2,
            "expiry exchanges the new JWT for new credentials",
          );
          for (let generation = 0; generation < 2; generation++) {
            assert.ok(
              tokenRequests[generation].authorization ===
                `bearer ${requestBearers[generation]}`,
              "token helper reads the current request bearer",
            );
            assert.equal(tokenRequests[generation].audience, audience);
            assert.equal(tokenRequests[generation].apiVersion, "2.0");
            assert.ok(
              exchanges[generation] === fakeJWT(generation),
              "CWIC exchanges the current raw JWT",
            );
          }
          assert.equal(unexpectedRequests.length, 0);

          const cleanupEnv = { ...useEnv, GITHUB_ENV: cleanupEnvFile };
          for (const [name, value] of Object.entries(state))
            cleanupEnv[`STATE_${name}`] = value;
          await run(
            process.execPath,
            [path.join(actionRoot, "dist/cleanup.js")],
            { env: cleanupEnv, cwd: fixture },
          );
          const restored = await readCommands(cleanupEnvFile);
          assert.deepEqual(restored, {
            AWS_SHARED_CREDENTIALS_FILE: sourceCredentials,
          });
          await assert.rejects(stat(state.workspace), { code: "ENOENT" });
          assert.equal(
            await readFile(sourceConfig, "utf8"),
            configured,
            "cleanup leaves the configured profile in the selected file",
          );
          assert.equal(
            await readFile(sourceCredentials, "utf8"),
            credentialsText,
            "original shared credentials are unchanged",
          );
          assert.equal(
            await readFile(inheritedConfig, "utf8"),
            "[default]\nregion = untouched\n",
            "config_file does not modify the inherited AWS_CONFIG_FILE",
          );
        },
      );
    }
  },
);

test(
  "bundled cleanup restores the default shared credentials path when its selector was absent",
  { skip: !enabled, timeout: 15_000 },
  async (t) => {
    const fixture = await temporaryDirectory(t, "caios cleanup integration ");
    const home = path.join(fixture, "fixture home");
    await mkdir(path.join(home, ".aws"), { recursive: true });
    const originalConfig = path.join(home, ".aws", "config");
    const originalCredentials = path.join(home, ".aws", "credentials");
    await writeFile(originalConfig, "[default]\nregion = us-east-1\n");
    await writeFile(
      originalCredentials,
      "[default]\naws_access_key_id = original-default-key\naws_secret_access_key = original-default-secret\n",
    );
    const env = isolatedEnv({
      RUNNER_TEMP: fixture,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "unused-request-token",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://unused.example/token",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_CLI_AUTO_PROMPT: "off",
      AWS_PAGER: "",
    });
    const state = {};
    const inputs = { region: "US-EAST-04A", "org-id": "cw-integration" };

    // Inject a fixture home and credential exchange to verify the shared-file
    // fallback without changing HOME or reading the runner's AWS files.
    await configureLogin({
      env,
      home,
      which: async (name) => name,
      runner: {
        getExecOutput: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            Version: 1,
            AccessKeyId: "temporary-caios-key",
            SecretAccessKey: "temporary-caios-secret",
            Expiration: new Date(Date.now() + 30 * 60_000).toISOString(),
          }),
        }),
      },
      toolkit: {
        getInput: (name) => inputs[name] || "",
        saveState: (name, value) => {
          state[name] = value;
        },
        exportVariable: (name, value) => {
          env[name] = value;
        },
        setSecret: () => {},
        info: () => {},
        setFailed: (message) => assert.fail(message),
      },
    });

    const cleanupEnvFile = path.join(fixture, "cleanup-env");
    await writeFile(cleanupEnvFile, "");
    const cleanupEnv = { ...env, GITHUB_ENV: cleanupEnvFile };
    for (const [name, value] of Object.entries(state))
      cleanupEnv[`STATE_${name}`] = value;
    await run(process.execPath, [path.join(actionRoot, "dist/cleanup.js")], {
      env: cleanupEnv,
      cwd: fixture,
    });
    const restored = await readCommands(cleanupEnvFile);
    assert.deepEqual(restored, {
      AWS_SHARED_CREDENTIALS_FILE: originalCredentials,
    });
    const credentials = JSON.parse(
      (
        await run(
          "aws",
          ["configure", "export-credentials", "--format", "process"],
          { env: { ...env, ...restored }, cwd: fixture },
        )
      ).stdout,
    );
    assert.equal(credentials.AccessKeyId, "original-default-key");
    assert.equal(credentials.SecretAccessKey, "original-default-secret");
    await assert.rejects(stat(state.workspace), { code: "ENOENT" });
  },
);
