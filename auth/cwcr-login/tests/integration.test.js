import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bundle = fileURLToPath(new URL("../compiled/token.cjs", import.meta.url));
const audience = "cwcr-login-ci";

// These run against a real GitHub OIDC endpoint, so they only work inside a
// job with `id-token: write`. Run with `npm run integration`.
const skip =
  !process.env.ACTIONS_ID_TOKEN_REQUEST_URL ||
  !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    ? "requires GitHub Actions OIDC environment"
    : false;

function fetchPayload() {
  const result = spawnSync(process.execPath, [bundle, audience], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.error || ""}\n${result.stderr}`);
  const [, payload] = result.stdout.split(".");
  return JSON.parse(Buffer.from(payload, "base64url"));
}

test(
  "bundled token script returns a token for the requested audience",
  { skip },
  () => {
    assert.equal(fetchPayload().aud, audience);
  },
);

test("each run of the token script requests a fresh token", { skip }, () => {
  const first = fetchPayload();
  const second = fetchPayload();
  assert.ok(first.jti, "token has a jti claim");
  assert.notEqual(second.jti, first.jti);
});
