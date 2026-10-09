import { HttpClient } from "@actions/http-client";

export function checkOIDCAccess(env) {
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
    throw new Error(
      "This job cannot request an OIDC token: ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN are not set. Add 'permissions: id-token: write' at the job or workflow level.",
    );
}

export function tokenURL(env, audience) {
  checkOIDCAccess(env);
  if (!audience) throw new Error("An OIDC audience is required.");
  const encodedAudience = encodeURIComponent(audience);
  return `${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodedAudience}`;
}

export async function fetchToken(
  audience,
  {
    env = process.env,
    client = new HttpClient("cwcr-login", [], {
      allowRetries: true,
      maxRetries: 3,
      socketTimeout: 20000,
    }),
  } = {},
) {
  const url = tokenURL(env, audience);
  const response = await client
    .getJson(url, {
      Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
    })
    .catch((error) => {
      throw new Error(
        `Failed to get GitHub OIDC token. Error Code: ${error.statusCode}. Error Message: ${error.message}`,
      );
    });
  const token = response.result?.value;
  if (!token)
    throw new Error("GitHub OIDC token response did not contain a token.");
  return token;
}
