import assert from "node:assert/strict";
import test from "node:test";

import { configureProfile } from "../src/profiles.js";

const options = {
  region: "US-EAST-04A",
  s3Endpoint: "https://cwobject.com",
  command: '/usr/bin/env "/tools/cwic" "auth" "accesskey" "oidc"',
};

for (const [profile, section] of [
  ["default", "default"],
  ["selected profile", 'profile "selected profile"'],
]) {
  test(`${profile} replaces the selected profile while preserving unrelated sections verbatim`, () => {
    const before = "# unrelated\r\n[profile other]\r\nregion = untouched\r\n";
    const after = "[services shared]\r\ns3 =\r\n    endpoint_url = https://original.example\r\n";
    const source = `${before}[${section}]
retry_mode = adaptive
ca_bundle = /custom/certs.pem
region = old-region
endpoint_url = https://old.example
ignore_configured_endpoint_urls = true
services = shared
s3 =
    max_concurrent_requests = 20
    addressing_style = path
    use_accelerate_endpoint = true
credential_process = /old/provider
${after}`;
    const updated = configureProfile(source, profile, options);
    assert.ok(updated.startsWith(before + after));
    assert.match(updated, /region = US-EAST-04A\nendpoint_url = https:\/\/cwobject\.com/);
    assert.match(updated, /s3 =\n    addressing_style = virtual\n/);
    assert.ok(updated.includes(`credential_process = ${options.command}\n`));
    assert.doesNotMatch(
      updated,
      /adaptive|certs\.pem|old-region|old\.example|ignore_configured_endpoint_urls|services = shared|max_concurrent_requests|use_accelerate_endpoint|\/old\/provider/,
    );
    assert.equal(updated.split(`[${section}]`).length, 2);
    assert.equal(updated.match(/^credential_process =/gm).length, 1);
  });
}

test("replaces all copies of a profile, including quoted headers and CRLF", () => {
  const source = `[profile 'target'] ; comment\r
  role_arn = obsolete-role\r
[profile target]
aws_access_key_id = obsolete-key
aws_secret_access_key = obsolete-secret
sso_session = obsolete-session
[profile "target"] # duplicate
credential_process = obsolete-process
    obsolete-continuation`;
  const updated = configureProfile(source, "target", options);
  assert.doesNotMatch(updated, /obsolete/);
  assert.equal(updated.match(/\[profile target\]/g).length, 1);
  assert.ok(updated.includes(`credential_process = ${options.command}\n`));
});

test("appends a new profile after a section with no final newline", () => {
  const source = "[profile other]\nregion = retained";
  const updated = configureProfile(source, "target", options);
  assert.ok(updated.startsWith(`${source}\n`));
  assert.match(updated, /\n\[profile target\]\nregion = US-EAST-04A/);
});
