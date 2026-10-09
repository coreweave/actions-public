import * as core from "@actions/core";
import { cleanup } from "./cleanup.js";

cleanup().catch((error) =>
  core.warning(`CWCR cleanup failed: ${error.message}`),
);
