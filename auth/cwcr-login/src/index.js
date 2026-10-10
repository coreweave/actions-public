import * as core from "@actions/core";
import { run } from "./cwcr-login.js";

run().catch((error) =>
  core.setFailed(`Failed to log into CWCR: ${error.message}`),
);
