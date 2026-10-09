import * as core from "@actions/core";
import * as exec from "@actions/exec";

export async function cleanup({
  core: toolkit = core,
  exec: runner = exec,
} = {}) {
  const registry = toolkit.getState("registry");
  if (!registry) return;
  try {
    await runner.exec("cwic", [
      "registry",
      "credential-helper",
      "unconfigure",
      registry,
    ]);
  } catch (error) {
    toolkit.warning(
      `Could not remove the CWCR credential helper binding for ${registry}: ${error.message}`,
    );
  }
}
