import { stripVTControlCharacters } from "node:util";

export const staticCredentials = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
];

export function failureDetails(stderr, env) {
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
