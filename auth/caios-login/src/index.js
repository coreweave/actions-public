import * as core from "@actions/core";
import * as exec from "@actions/exec";

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

async function run() {
  // Check that awscli is installed
  await prereqs();

  try {
    // Get inputs
    const region = core.getInput("region", { required: true });
    const orgId = core.getInput("org-id", { required: true });
    const profile = core.getInput("profile") || "";
    const audience = core.getInput("audience") || "https://coreweave.com/iam";
    const endpoint =
      core.getInput("oidc-endpoint") ||
      "https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc";
    const s3Endpoint = core.getInput("s3-endpoint") || "https://cwobject.com";

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
    const profileArgs =
      profile && profile !== "default" ? ["--profile", profile] : [];
    core.info(
      `Configuring AWS CLI${profileArgs.length ? ` for profile: ${profile}` : ""}...`,
    );

    // Set AWS configuration
    await exec.exec("aws", [
      "configure",
      "set",
      "s3.addressing_style",
      "virtual",
      ...profileArgs,
    ]);
    await exec.exec("aws", [
      "configure",
      "set",
      "region",
      region,
      ...profileArgs,
    ]);
    await exec.exec("aws", [
      "configure",
      "set",
      "endpoint_url",
      s3Endpoint,
      ...profileArgs,
    ]);

    // If using a profile, set the credentials in the profile
    if (profile && profile !== "default") {
      await exec.exec("aws", [
        "configure",
        "set",
        "aws_access_key_id",
        credentials.AccessKeyID,
        ...profileArgs,
      ]);
      await exec.exec("aws", [
        "configure",
        "set",
        "aws_secret_access_key",
        credentials.SecretAccessKey,
        ...profileArgs,
      ]);
      if (credentials.Token) {
        await exec.exec("aws", [
          "configure",
          "set",
          "aws_session_token",
          credentials.Token,
          ...profileArgs,
        ]);
      }
    }

    core.info("CAIOS login successful!");
  } catch (error) {
    core.setFailed(`Action failed with error: ${error.message}`);
  }
}

// Run the action
run();
