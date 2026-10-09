import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchToken, tokenURL } from "../src/token.js";

const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test/token?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};

function fakeClient(
  t,
  response = { statusCode: 200, result: { value: "jwt" } },
) {
  return {
    getJson: t.mock.fn(async () => response),
  };
}

for (const [name, partial] of [
  ["request URL", { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token" }],
  [
    "request token",
    { ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.test/token" },
  ],
]) {
  test(`rejects a missing ${name} before any request`, async (t) => {
    const client = fakeClient(t);
    await assert.rejects(
      fetchToken("cwcr-acme", { env: partial, client }),
      /ACTIONS_ID_TOKEN_REQUEST/,
    );
    assert.equal(client.getJson.mock.callCount(), 0);
  });
}

test("rejects an empty audience before any request", async (t) => {
  const client = fakeClient(t);
  await assert.rejects(fetchToken("", { env, client }), /audience/i);
  assert.equal(client.getJson.mock.callCount(), 0);
});

test("requests the token with the bearer header and returns it", async (t) => {
  const client = fakeClient(t);
  assert.equal(await fetchToken("cwcr-acme", { env, client }), "jwt");
  assert.equal(client.getJson.mock.callCount(), 1);
  const [url, headers] = client.getJson.mock.calls[0].arguments;
  assert.equal(url, `${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=cwcr-acme`);
  assert.deepEqual(headers, { Authorization: "Bearer request-token" });
});

test("URL-encodes the audience", () => {
  assert.equal(
    tokenURL(env, "a b&c"),
    `${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=a%20b%26c`,
  );
});

test("surfaces the status and message of an HTTP error", async (t) => {
  const client = fakeClient(t);
  client.getJson = async () => {
    throw Object.assign(new Error("Failed request: (401)"), {
      statusCode: 401,
    });
  };
  await assert.rejects(
    fetchToken("cwcr-acme", { env, client }),
    /401.*Failed request/,
  );
});

test("rejects a response with no token", async (t) => {
  const client = fakeClient(t, { statusCode: 200, result: {} });
  await assert.rejects(
    fetchToken("cwcr-acme", { env, client }),
    /did not contain a token/,
  );
});
