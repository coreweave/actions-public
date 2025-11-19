/*
  This is KNOWN to not work right now, but will in the future
  with some backend API changes.
*/
import * as core from "@actions/core";
import * as exec from "@actions/exec";

async function cleanup() {
  try {
    // Get the profile input
    const profile = core.getInput("profile") || "";

    // Get the stored access key ID from the environment or output
    let accessKeyId = process.env.AWS_ACCESS_KEY_ID;

    // If using a profile, we need to get the access key from the profile config
    if (profile && profile !== "default") {
      try {
        let output = "";
        await exec.exec(
          "aws",
          ["configure", "get", "aws_access_key_id", "--profile", profile],
          {
            silent: true,
            listeners: {
              stdout: (data) => {
                output += data.toString();
              },
            },
          },
        );
        accessKeyId = output.trim();
      } catch (error) {
        // Profile might not exist, that's ok
        core.info("No profile credentials found to clean up");
      }
    }

    if (!accessKeyId) {
      core.info("No access key to revoke, skipping cleanup");
      return;
    }

    // Get inputs that we need for cleanup
    const audience = core.getInput("audience") || "https://coreweave.com/iam";

    // Get a fresh ID token for the revoke request
    core.info("Getting ID token for cleanup...");
    const idToken = await core.getIDToken(audience);

    // Revoke the access key
    core.info(`Revoking access key: ${accessKeyId}`);

    const revokeEndpoint =
      "https://api.coreweave.com/v1/cwobject/revoke-access-key/access-key";

    const response = await fetch(revokeEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        accessKeyId: accessKeyId,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Don't fail the workflow if cleanup fails, just warn
      core.warning(
        `Failed to revoke access key: HTTP ${response.status}: ${errorText}`,
      );
    } else {
      core.info("Access key successfully revoked");
    }

    // Clear the credentials from environment or profile
    if (!profile || profile === "default") {
      core.exportVariable("AWS_ACCESS_KEY_ID", "");
      core.exportVariable("AWS_SECRET_ACCESS_KEY", "");
      core.exportVariable("AWS_SESSION_TOKEN", "");
    } else {
      // Clear profile credentials
      try {
        await exec.exec("aws", [
          "configure",
          "set",
          "aws_access_key_id",
          "",
          "--profile",
          profile,
        ]);
        await exec.exec("aws", [
          "configure",
          "set",
          "aws_secret_access_key",
          "",
          "--profile",
          profile,
        ]);
        await exec.exec("aws", [
          "configure",
          "set",
          "aws_session_token",
          "",
          "--profile",
          profile,
        ]);
      } catch (error) {
        core.warning(`Failed to clear profile credentials: ${error.message}`);
      }
    }
  } catch (error) {
    // Don't fail the workflow if cleanup fails
    core.warning(`Cleanup failed: ${error.message}`);
  }
}

// Run cleanup
cleanup();
