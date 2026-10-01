import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const bundle = fileURLToPath(new URL("../compiled/index.cjs", import.meta.url));

async function snapshot(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? await snapshot(file)
      : await readFile(file, "utf8");
  }
  return result;
}

test(
  "bundled installer selects releases without credentials and preserves configuration",
  { timeout: 300000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "setup-cwic-integration-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const testHome = path.join(directory, "home");
    for (const relative of [
      ".config/cwic/config.yaml",
      ".docker/config.json",
      ".aws/config",
      ".aws/credentials",
    ]) {
      const file = path.join(testHome, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "setup-cwic configuration preservation sentinel\n");
    }
    const before = await snapshot(testHome);
    const env = {
      ...process.env,
      HOME: testHome,
      XDG_CONFIG_HOME: path.join(testHome, ".config"),
      DOCKER_CONFIG: path.join(testHome, ".docker"),
      AWS_CONFIG_FILE: path.join(testHome, ".aws/config"),
      AWS_SHARED_CREDENTIALS_FILE: path.join(testHome, ".aws/credentials"),
      RUNNER_TEMP: directory,
      GITHUB_PATH: path.join(directory, "github-path"),
      GITHUB_OUTPUT: path.join(directory, "github-output"),
    };
    for (const key of Object.keys(env)) {
      if (
        /^(ACTIONS_ID_TOKEN_|CWIC_|COREWEAVE_|AWS_ACCESS_KEY_ID$|AWS_SECRET_ACCESS_KEY$|AWS_SESSION_TOKEN$|GITHUB_TOKEN$|GH_TOKEN$)/.test(
          key,
        )
      )
        delete env[key];
    }
    for (const version of ["", "v1.46.0"]) {
      await writeFile(env.GITHUB_PATH, "");
      await writeFile(env.GITHUB_OUTPUT, "");
      const installed = spawnSync(process.execPath, [bundle], {
        cwd: directory,
        env: { ...env, INPUT_VERSION: version },
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(
        installed.status,
        0,
        `${installed.error || ""}\n${installed.stdout}\n${installed.stderr}`,
      );
      const output = await readFile(env.GITHUB_OUTPUT, "utf8");
      const tag = /^version<<[^\n]+\n([^\n]+)\n/m.exec(output)?.[1];
      assert.ok(tag, `Missing resolved release output: ${output}`);
      if (version) assert.equal(tag, version);
      const installedPath = (await readFile(env.GITHUB_PATH, "utf8")).trim();
      assert.ok(installedPath.startsWith(`${directory}${path.sep}`));
      const check = spawnSync("cwic", ["version"], {
        cwd: directory,
        env: { ...env, PATH: `${installedPath}${path.delimiter}${env.PATH}` },
        encoding: "utf8",
        timeout: 30000,
      });
      assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
      assert.ok(
        check.stdout.includes(`version ${tag.replace(/^v/, "")} `),
        check.stdout,
      );
      assert.deepEqual(await snapshot(testHome), before);
    }
    for (const [version, expected] of [
      [">=1.0.0", /exact release tag or latest/],
      ["v0.0.0-setup-cwic-unavailable", /not found/],
    ]) {
      await writeFile(env.GITHUB_PATH, "");
      await writeFile(env.GITHUB_OUTPUT, "");
      const rejected = spawnSync(process.execPath, [bundle], {
        cwd: directory,
        env: { ...env, INPUT_VERSION: version },
        encoding: "utf8",
        timeout: 60000,
      });
      assert.equal(
        rejected.status,
        1,
        `${rejected.stdout}\n${rejected.stderr}`,
      );
      assert.match(rejected.stdout, expected);
      assert.equal(await readFile(env.GITHUB_PATH, "utf8"), "");
      assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "");
      assert.deepEqual(await snapshot(testHome), before);
    }
  },
);
