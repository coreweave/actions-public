import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as fs from "fs";
import * as path from "path";

import { fromHttp } from "@aws-sdk/credential-providers";
import { S3 } from "@aws-sdk/client-s3";

// Check for Pre-Requisites
async function prereqs() {
  try {
    // Option 1: Try to execute the command and catch errors
    await exec.exec("aws", ["--version"]);
    core.info("awscli is installed");
  } catch (error) {
    core.error(`awscli is not installed`);
  }
}

function profileArgs(profile) {
  return profile && profile !== "default" ? ["--profile", profile] : [];
}

async function configureEndpoint(region, s3Endpoint, args) {
  await exec.exec("aws", [
    "configure",
    "set",
    "s3.addressing_style",
    "virtual",
    ...args,
  ]);
  await exec.exec("aws", [
    "configure",
    "set",
    "region",
    region,
    ...args,
  ]);
  await exec.exec("aws", [
    "configure",
    "set",
    "endpoint_url",
    s3Endpoint,
    ...args,
  ]);
}

// refresh: true writes credential_process instead of static keys. The AWS SDK
// re-runs refresh.js near expiry; that script repeats getIDToken + fromHttp.
async function runRefresh({
  region,
  orgId,
  profile,
  audience,
  endpoint,
  s3Endpoint,
}) {
  const actionPath = process.env.GITHUB_ACTION_PATH;
  if (!actionPath) {
    throw new Error("GITHUB_ACTION_PATH is required to locate refresh.js");
  }

  if (
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    process.env.AWS_SESSION_TOKEN
  ) {
    core.warning(
      "AWS_ACCESS_KEY_* is already set. Static keys override credential_process for later steps.",
    );
  }

  const script = path.join(actionPath, "refresh.js");
  await fs.promises.chmod(script, 0o700);

  const args = profileArgs(profile);
  core.exportVariable("AWS_SDK_LOAD_CONFIG", "1");
  core.exportVariable("AWS_EC2_METADATA_DISABLED", "true");
  core.exportVariable("AWS_REGION", region);
  core.exportVariable("AWS_DEFAULT_REGION", region);
  core.exportVariable("CAIOS_OIDC_AUDIENCE", audience);
  core.exportVariable("CAIOS_ORG_ID", orgId);
  core.exportVariable("CAIOS_OIDC_ENDPOINT", endpoint);

  await configureEndpoint(region, s3Endpoint, args);
  await exec.exec("aws", [
    "configure",
    "set",
    "credential_process",
    script,
    ...args,
  ]);

  core.info("Verifying CAIOS OIDC exchange...");
  let stdout = "";
  let stderr = "";
  const exitCode = await exec.exec(script, [], {
    silent: true,
    ignoreReturnCode: true,
    listeners: {
      stdout: (data) => {
        stdout += data.toString();
      },
      stderr: (data) => {
        stderr += data.toString();
      },
    },
  });
  if (exitCode !== 0) {
    throw new Error(
      `credential refresh check failed (exit ${exitCode}): ${stderr.trim()}`,
    );
  }

  let minted;
  try {
    minted = JSON.parse(stdout);
  } catch (error) {
    throw new Error("credential refresh check did not return JSON");
  }
  if (minted.SecretAccessKey) {
    core.setSecret(minted.SecretAccessKey);
  }
  if (minted.SessionToken) {
    core.setSecret(minted.SessionToken);
  }
  if (
    minted.Version !== 1 ||
    !minted.AccessKeyId ||
    !minted.SecretAccessKey ||
    !minted.Expiration
  ) {
    throw new Error(
      "credential refresh check returned incomplete credentials",
    );
  }

  core.info(
    `CAIOS login successful (refreshable); verified key ${minted.AccessKeyId}`,
  );
}

async function runOnce({
  region,
  orgId,
  profile,
  audience,
  endpoint,
  s3Endpoint,
}) {
  // Step 1: Get ID Token
  core.info("Getting ID token...");
  const idToken = await core.getIDToken(audience);

  const s3 = new S3({
    credentials: fromHttp({
      awsContainerCredentialsFullUri: `${endpoint}/${orgId}`,
      awsContainerAuthorizationToken: idToken,
    }),
  });

  // Step 2: Get credentials from CAIOS
  core.info("Getting CAIOS Credentials...");
  const creds = await s3.config.credentials();

  const credentials = {
    AccessKeyID: creds.accessKeyId,
    SecretAccessKey: creds.secretAccessKey,
    Token: creds.sessionToken,
  };

  // Step 3: Export credentials to environment
  core.info(`Setting AWS credentials for ${credentials.AccessKeyID}...`);

  // Only export to environment if using default profile
  if (!profile || profile === "default") {
    core.exportVariable("AWS_ACCESS_KEY_ID", credentials.AccessKeyID);

    // Mask the secret key
    core.setSecret(credentials.SecretAccessKey);
    core.exportVariable("AWS_SECRET_ACCESS_KEY", credentials.SecretAccessKey);

    // If session token exists, export it too
    if (credentials.Token) {
      core.setSecret(credentials.Token);
      core.exportVariable("AWS_SESSION_TOKEN", credentials.Token);
    }
  } else {
    // Still mask the secrets even when using profiles
    core.setSecret(credentials.SecretAccessKey);
    if (credentials.Token) {
      core.setSecret(credentials.Token);
    }
  }

  // Step 4: Configure AWS CLI
  const args = profileArgs(profile);
  core.info(
    `Configuring AWS CLI${args.length ? ` for profile: ${profile}` : ""}...`,
  );

  await configureEndpoint(region, s3Endpoint, args);

  // If using a profile, set the credentials in the profile
  if (profile && profile !== "default") {
    await exec.exec("aws", [
      "configure",
      "set",
      "aws_access_key_id",
      credentials.AccessKeyID,
      ...args,
    ]);
    await exec.exec("aws", [
      "configure",
      "set",
      "aws_secret_access_key",
      credentials.SecretAccessKey,
      ...args,
    ]);
    if (credentials.Token) {
      await exec.exec("aws", [
        "configure",
        "set",
        "aws_session_token",
        credentials.Token,
        ...args,
      ]);
    }
  }

  core.info("CAIOS login successful!");
}

async function run() {
  // Check that awscli is installed
  await prereqs();

  try {
    // Get inputs
    const inputs = {
      region: core.getInput("region", { required: true }),
      orgId: core.getInput("org-id", { required: true }),
      profile: core.getInput("profile") || "",
      audience: core.getInput("audience") || "https://coreweave.com/iam",
      endpoint:
        core.getInput("oidc-endpoint") ||
        "https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc",
      s3Endpoint: core.getInput("s3-endpoint") || "https://cwobject.com",
    };

    if (core.getBooleanInput("refresh")) {
      await runRefresh(inputs);
      return;
    }

    await runOnce(inputs);
  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

// Run the action
run();
