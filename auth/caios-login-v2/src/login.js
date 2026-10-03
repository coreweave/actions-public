import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { configureProfile, withoutProfile } from "./profiles.js";

const oidcPath = "/v1/cwobject/temporary-credentials/oidc";
const staticCredentials = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
];
const webIdentityCredentials = [
  "AWS_ROLE_ARN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_SESSION_NAME",
];

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// The CLI parses arguments directly, while some SDKs use a shell. Reject shell
// expansion characters that cannot be escaped consistently across both.
export function credentialCommand(args) {
  if (args.some((arg) => /[$`\r\n\0]/.test(arg))) {
    throw new Error(
      "Credential command arguments must not contain dollar signs, backticks, or line breaks.",
    );
  }
  return args
    .map((arg) => `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(" ");
}

export function tokenScript(audience) {
  return `#!/bin/sh
set -eu
: "\${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?Missing GitHub OIDC token request token; grant id-token: write}"
: "\${ACTIONS_ID_TOKEN_REQUEST_URL:?Missing GitHub OIDC token request URL; grant id-token: write}"
response="$(curl -sSf --connect-timeout 10 --max-time 30 --retry 2 --retry-max-time 60 --get --data-urlencode ${shellQuote(`audience=${audience}`)} \\
  -H "Authorization: bearer \${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \\
  "\${ACTIONS_ID_TOKEN_REQUEST_URL}" </dev/null)"
token="$(printf '%s\\n' "$response" \\
  | sed -n 's/.*"value"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')"
if [ -z "$token" ]; then
  echo "GitHub OIDC response did not contain a token" >&2
  exit 1
fi
printf '%s\\n' "$token"
`;
}

export function apiOrigin(endpoint) {
  const url = new URL(endpoint);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.pathname.replace(/\/$/, "") !== oidcPath ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `oidc-endpoint must use the path ${oidcPath} with no query, fragment, or user credentials; CWIC supports overriding the API origin only.`,
    );
  }
  return url.origin;
}

async function readOptional(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function failureDetails(stderr, env) {
  let details = stripVTControlCharacters(stderr || "");
  for (const name of [
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "COREWEAVE_API_TOKEN",
    ...staticCredentials,
  ]) {
    if (env[name]) details = details.replaceAll(env[name], "[REDACTED]");
  }
  // CWIC forwards API error bodies, which may echo a JWT or credential fields.
  details = details
    .replace(
      /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /((?:["']?)(?:AccessKeyId|SecretAccessKey|SessionToken|Token|access_token|id_token|Authorization)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Bearer\s+)?[^\s,;}\]]+)/gi,
      "$1[REDACTED]",
    );
  return (
    details.trim().slice(0, 4096) || "CWIC did not write diagnostics to stderr."
  );
}

async function validatePrerequisites({ toolkit, which, env, home }) {
  const region = toolkit.getInput("region", { required: true });
  const orgId = toolkit.getInput("org-id", { required: true });
  const profile = toolkit.getInput("profile") || "default";
  const configPath = toolkit.getInput("config_file") || "~/.aws/config";
  const audience =
    toolkit.getInput("audience") || "https://coreweave.com/iam";
  const endpoint =
    toolkit.getInput("oidc-endpoint") ||
    `https://api.coreweave.com${oidcPath}`;
  const s3Endpoint =
    toolkit.getInput("s3-endpoint") || "https://cwobject.com";
  for (const [name, value] of Object.entries({
    region,
    "org-id": orgId,
    profile,
    config_file: configPath,
    audience,
    "s3-endpoint": s3Endpoint,
  })) {
    if (/[\r\n\0]/.test(value))
      throw new Error(`${name} must be a single line.`);
  }
  if (/[\[\]"']/.test(profile))
    throw new Error("profile must not contain brackets or quotes.");
  const apiUrl = apiOrigin(endpoint);
  if (
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
    !env.ACTIONS_ID_TOKEN_REQUEST_URL
  ) {
    throw new Error(
      "GitHub OIDC is unavailable. Grant this job id-token: write.",
    );
  }
  if (!env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is required.");
  let cwic;
  try {
    cwic = await which("cwic", true);
  } catch {
    throw new Error(
      "CWIC with OIDC credential-process support is required. Run coreweave/actions-public/cwic/setup-cwic before caios-login-v2.",
    );
  }
  for (const tool of ["/usr/bin/env", "sh", "curl", "sed"])
    await which(tool, true);
  const configFile = path.resolve(
    configPath.startsWith("~/") ? path.join(home, configPath.slice(2)) : configPath,
  );
  return { region, orgId, profile, configFile, audience, s3Endpoint, apiUrl, cwic };
}

export async function run({
  toolkit = core,
  runner = exec,
  which = io.which,
  env = process.env,
  home = homedir(),
} = {}) {
  let workspace;
  try {
    const { region, orgId, profile, configFile, audience, s3Endpoint, apiUrl, cwic } =
      await validatePrerequisites({ toolkit, which, env, home });
    workspace = await mkdtemp(path.join(env.RUNNER_TEMP, "caios-login-"));
    toolkit.saveState("workspace", workspace);
    const helper = path.join(workspace, "github-oidc.sh");
    await writeFile(helper, tokenScript(audience), { mode: 0o700 });
    const args = [
      "auth",
      "accesskey",
      "oidc",
      "--org-id",
      orgId,
      "--storage=disk",
      "--cache-dir",
      path.join(workspace, "cache"),
      "--api-url",
      apiUrl,
      "--",
      helper,
    ];
    // An unquoted executable prevents the Go SDK's INI parser from stripping
    // the first and last argument quotes and corrupting the command.
    const command = `/usr/bin/env ${credentialCommand([cwic, ...args])}`;

    // Authenticate now to fail this step on a bad trust policy. Keep stdout out
    // of the job log; subsequent AWS calls use the same renewable CWIC cache.
    const result = await runner.getExecOutput(credentialCommand([cwic]), args, {
      silent: true,
      ignoreReturnCode: true,
      env,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `CWIC OIDC authentication failed (exit code ${result.exitCode}): ${failureDetails(result.stderr, env)}`,
      );
    }
    let credentials;
    try {
      credentials = JSON.parse(result.stdout);
    } catch {
      // JSON parse errors can include a fragment of the credential response.
      throw new Error("CWIC did not return valid AWS process credential JSON.");
    }
    for (const secret of [
      credentials.AccessKeyId,
      credentials.SecretAccessKey,
      credentials.SessionToken,
    ]) {
      if (secret) toolkit.setSecret(secret);
    }
    if (
      credentials.Version !== 1 ||
      !credentials.AccessKeyId ||
      !credentials.SecretAccessKey ||
      !(Date.parse(credentials.Expiration) > Date.now())
    ) {
      throw new Error(
        "CWIC did not return valid, expiring AWS process credentials.",
      );
    }

    const credentialsFile = path.join(workspace, "credentials");
    const config = configureProfile(
      await readOptional(configFile),
      profile,
      { region, s3Endpoint, command },
    );
    const previousCredentialsFile =
      env.AWS_SHARED_CREDENTIALS_FILE || path.join(home, ".aws", "credentials");
    const sharedCredentials = withoutProfile(
      await readOptional(previousCredentialsFile),
      profile,
    );
    await writeFile(credentialsFile, sharedCredentials, { mode: 0o600 });
    await mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
    await writeFile(configFile, config, { mode: 0o600 });

    toolkit.saveState("previousCredentialsFile", previousCredentialsFile);
    toolkit.exportVariable("AWS_CONFIG_FILE", configFile);
    toolkit.exportVariable("AWS_SHARED_CREDENTIALS_FILE", credentialsFile);
    if (profile === "default") {
      toolkit.exportVariable("AWS_PROFILE", "default");
      toolkit.exportVariable("AWS_DEFAULT_PROFILE", "default");
      // Environment credential providers take precedence over credential_process.
      for (const name of [...webIdentityCredentials, ...staticCredentials])
        toolkit.exportVariable(name, "");
    }
    toolkit.info(
      `CAIOS profile ${profile} configured with renewable OIDC credentials.`,
    );
  } catch (error) {
    if (workspace) await rm(workspace, { recursive: true, force: true });
    toolkit.setFailed(`CAIOS login failed: ${error.message}`);
  }
}

export async function cleanup({ toolkit = core, env = process.env } = {}) {
  try {
    const workspace = toolkit.getState("workspace");
    if (!workspace) return;
    const previousCredentialsFile = toolkit.getState("previousCredentialsFile");
    // Stop pointing at the file we delete, unless a later step replaced it.
    if (
      previousCredentialsFile &&
      env.AWS_SHARED_CREDENTIALS_FILE === path.join(workspace, "credentials")
    ) {
      toolkit.exportVariable("AWS_SHARED_CREDENTIALS_FILE", previousCredentialsFile);
    }
    await rm(workspace, { recursive: true, force: true });
    toolkit.info(
      "Removed CAIOS credential helper and temporary credential cache.",
    );
  } catch (error) {
    toolkit.warning(`CAIOS cleanup failed: ${error.message}`);
  }
}
