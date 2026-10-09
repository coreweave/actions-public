import * as core from "@actions/core";
import * as exec from "@actions/exec";
import * as io from "@actions/io";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkOIDCAccess } from "./token.js";

// The token script is bundled next to this file as compiled/token.cjs.
const tokenScript = fileURLToPath(new URL("token.cjs", import.meta.url));

async function checkCwic(tools) {
  const cwic = await tools.which("cwic", false);
  if (!cwic)
    throw new Error(
      "cwic is not on PATH. Run coreweave/actions-public/cwic/setup-cwic before this action.",
    );
}

async function installHelper(runner, tempDir) {
  if (!tempDir)
    throw new Error("RUNNER_TEMP must be set to a runner-writable directory.");
  const bin = await mkdtemp(path.join(tempDir, "cwcr-login-"));
  await runner.exec("cwic", [
    "registry",
    "credential-helper",
    "install",
    "--bin-dir",
    bin,
  ]);
  return bin;
}

async function configureRegistry(runner, registry, audience) {
  await runner.exec("cwic", [
    "registry",
    "credential-helper",
    "configure",
    registry,
    "--oidc",
    "--",
    process.execPath,
    tokenScript,
    audience,
  ]);
}

export async function run({
  core: toolkit = core,
  exec: runner = exec,
  io: ioTools = io,
  env = process.env,
} = {}) {
  try {
    const registry = toolkit.getInput("registry", { required: true });
    const audience = toolkit.getInput("audience", { required: true });
    checkOIDCAccess(env);
    await checkCwic(ioTools);
    const bin = await installHelper(runner, env.RUNNER_TEMP);
    toolkit.addPath(bin);
    await configureRegistry(runner, registry, audience);
    // Tell the post step which registry to unconfigure.
    toolkit.saveState("registry", registry);
  } catch (error) {
    toolkit.setFailed(`Failed to log into CWCR: ${error.message}`);
  }
}
