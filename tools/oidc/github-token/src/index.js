// Description: This action gets an OIDC token from the GitHub token API.
const core = require("@actions/core");

async function getOIDCTokenAction() {
  // get and set default OIDC Token (default audience)
  const id_token_default = await core.getIDToken(); // OIDC Token with default audience
  core.setSecret(id_token_default);
  core.setOutput("id_token_default", id_token_default);

  // get and set OIDC Token with custom audience
  const audience = core.getInput("audience", { required: false });
  if (audience !== "") {
    const id_token_audience = await core.getIDToken(audience); // OIDC token with custom audience
    core.setSecret(id_token_audience);
    core.setOutput("id_token_audience", id_token_audience);
  }
}

getOIDCTokenAction();
