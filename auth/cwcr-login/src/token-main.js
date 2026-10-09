import { fetchToken } from "./token.js";

// Runs as the credential helper's OIDC command: print a fresh GitHub OIDC
// token for the audience given as the only argument.
fetchToken(process.argv[2])
  .then((token) => process.stdout.write(token))
  .catch((error) => {
    process.stderr.write(`cwcr-login: ${error.message}\n`);
    process.exit(1);
  });
