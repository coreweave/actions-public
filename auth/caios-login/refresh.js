#!/usr/bin/env node
// AWS credential_process for caios-login refresh mode.
// Repeats the action's OIDC exchange: a new GitHub Actions JWT, then
// GET ${CAIOS_OIDC_ENDPOINT}/${CAIOS_ORG_ID} with that JWT as Authorization
// (the same request the AWS SDK fromHttp provider makes).
// stdout must be only credential_process JSON. Logs go to stderr.

function fail(message) {
  console.error(message);
  process.exit(1);
}

const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
const audience = process.env.CAIOS_OIDC_AUDIENCE;
const orgId = process.env.CAIOS_ORG_ID;
const oidcEndpoint = process.env.CAIOS_OIDC_ENDPOINT;

if (!requestUrl || !requestToken) {
  fail(
    "ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN are required (permissions.id-token: write)",
  );
}
if (!audience || !orgId || !oidcEndpoint) {
  fail(
    "CAIOS_OIDC_AUDIENCE, CAIOS_ORG_ID, and CAIOS_OIDC_ENDPOINT are required",
  );
}

async function main() {
  const tokenResponse = await fetch(
    `${requestUrl}&audience=${encodeURIComponent(audience)}`,
    { headers: { Authorization: `bearer ${requestToken}` } },
  );
  if (!tokenResponse.ok) {
    fail(`GitHub OIDC token request failed: HTTP ${tokenResponse.status}`);
  }
  const tokenBody = await tokenResponse.json();
  const idToken = tokenBody.value;
  if (typeof idToken !== "string" || idToken === "") {
    fail("GitHub OIDC token response is missing value");
  }

  const endpoint = `${oidcEndpoint.replace(/\/$/, "")}/${orgId}`;
  const credsResponse = await fetch(endpoint, {
    headers: { Authorization: idToken },
  });
  if (!credsResponse.ok) {
    fail(`CAIOS credential request failed: HTTP ${credsResponse.status}`);
  }
  const creds = await credsResponse.json();
  if (
    typeof creds.AccessKeyId !== "string" ||
    typeof creds.SecretAccessKey !== "string" ||
    typeof creds.Expiration !== "string"
  ) {
    fail(
      "CAIOS credential response is missing AccessKeyId, SecretAccessKey, or Expiration",
    );
  }

  const out = {
    Version: 1,
    AccessKeyId: creds.AccessKeyId,
    SecretAccessKey: creds.SecretAccessKey,
    Expiration: creds.Expiration,
  };
  if (typeof creds.Token === "string" && creds.Token !== "") {
    out.SessionToken = creds.Token;
  }

  process.stdout.write(JSON.stringify(out));
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
