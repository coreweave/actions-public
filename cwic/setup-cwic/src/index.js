import * as core from "@actions/core";
import { run } from "./setup-cwic.js";

run().catch((error) =>
  core.setFailed(`Failed to set up CWIC: ${error.message}`),
);
