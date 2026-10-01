import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  archiveName,
  resolveRelease,
  run,
  verifyChecksum,
} from "../src/setup-cwic.js";

const archive = Buffer.from("test archive");
const digest = createHash("sha256").update(archive).digest("hex");
const assetName = "cwic_Linux_x86_64.tar.gz";
const redirect = (
  statusCode = 302,
  location = "https://github.com/coreweave/cwic/releases/tag/v1.46.0",
) => ({
  message: { statusCode, headers: { location } },
  readBody: async () => "",
});

async function fixture(t, version = "") {
  const tempDir = await mkdtemp(path.join(tmpdir(), "setup-cwic-test-"));
  t.after(() => rm(tempDir, { recursive: true, force: true }));
  const calls = {
    paths: [],
    outputs: [],
    failures: [],
    downloads: [],
    extractions: [],
  };
  const deps = {
    platform: "linux",
    arch: "x64",
    tempDir,
    core: {
      getInput: () => version,
      addPath: (value) => calls.paths.push(value),
      setOutput: (...args) => calls.outputs.push(args),
      setFailed: (value) => calls.failures.push(value),
      info: () => {},
    },
    client: {
      get: t.mock.fn(async () => redirect()),
      dispose: t.mock.fn(),
    },
    toolCache: {
      downloadTool: async (url, destination) => {
        calls.downloads.push(url);
        await writeFile(
          destination,
          url.endsWith("checksums.txt") ? `${digest}  ${assetName}\n` : archive,
        );
        return destination;
      },
      extractTar: async (file, destination) => {
        calls.extractions.push(file);
        await writeFile(path.join(destination, "cwic"), "executable");
        return destination;
      },
    },
  };
  return { deps, calls, tempDir };
}

for (const [platform, arch, expected] of [
  ["linux", "x64", "cwic_Linux_x86_64.tar.gz"],
  ["linux", "arm64", "cwic_Linux_arm64.tar.gz"],
  ["darwin", "x64", "cwic_Darwin_x86_64.tar.gz"],
  ["darwin", "arm64", "cwic_Darwin_arm64.tar.gz"],
]) {
  test(`maps ${platform}/${arch} to its release asset`, () => {
    assert.equal(archiveName(platform, arch), expected);
  });
}

for (const [platform, arch] of [
  ["win32", "x64"],
  ["linux", "ia32"],
  ["freebsd", "arm64"],
]) {
  test(`rejects ${platform}/${arch}`, () => {
    assert.throws(
      () => archiveName(platform, arch),
      /Unsupported runner platform/,
    );
  });
}

for (const version of ["", "latest", "v1.46.0"]) {
  test(`installs ${version || "the default"} and reports the resolved tag`, async (t) => {
    const { deps, calls, tempDir } = await fixture(t, version);
    await run(deps);
    assert.deepEqual(calls.failures, []);
    assert.deepEqual(calls.outputs, [["version", "v1.46.0"]]);
    assert.equal(calls.paths.length, 1);
    assert.equal(
      await readFile(path.join(calls.paths[0], "cwic"), "utf8"),
      "executable",
    );
    assert.equal(
      (await stat(path.join(calls.paths[0], "cwic"))).mode & 0o777,
      0o755,
    );
    assert.equal(calls.extractions.length, 1);
    assert.deepEqual(await readdir(path.dirname(calls.paths[0])), ["bin"]);
    assert.equal((await readdir(tempDir)).length, 1);
    if (version === "v1.46.0")
      assert.equal(deps.client.get.mock.callCount(), 0);
    else
      assert.equal(
        deps.client.get.mock.calls[0].arguments[0],
        "https://github.com/coreweave/cwic/releases/latest",
      );
    assert.deepEqual(calls.downloads, [
      `https://github.com/coreweave/cwic/releases/download/v1.46.0/${assetName}`,
      "https://github.com/coreweave/cwic/releases/download/v1.46.0/checksums.txt",
    ]);
    assert.equal(deps.client.dispose.mock.callCount(), 1);
  });
}

test("supports exact prerelease tags and encodes the tag in URLs", async (t) => {
  const { deps, calls } = await fixture(t, "preview/v2.0.0");
  await run(deps);
  assert.deepEqual(calls.failures, []);
  assert.equal(deps.client.get.mock.callCount(), 0);
  assert.match(calls.downloads[0], /download\/preview%2Fv2\.0\.0\//);
});

for (const version of [
  ">=1.0.0",
  "^1.0",
  "v1.0.0\n",
  "../v1",
  "https://example.com",
]) {
  test(`rejects invalid version ${JSON.stringify(version)} before network access`, async (t) => {
    const { deps, calls } = await fixture(t, version);
    await run(deps);
    assert.match(calls.failures[0], /exact release tag or latest/);
    assert.equal(deps.client.get.mock.callCount(), 0);
    assert.equal(calls.downloads.length, 0);
  });
}

test("fails unsupported runners before network access", async (t) => {
  const { deps, calls } = await fixture(t);
  deps.platform = "win32";
  await run(deps);
  assert.match(calls.failures[0], /Unsupported runner platform/);
  assert.equal(deps.client.get.mock.callCount(), 0);
});

for (const [name, response, message] of [
  ["missing release", redirect(404), /release.*not found/i],
  ["rate limit", redirect(403), /HTTP 403/],
  ["server failure", redirect(500), /HTTP 500/],
  ["no redirect", redirect(200), /HTTP 200/],
  ["missing location", redirect(302, ""), /Invalid latest release redirect/],
  [
    "wrong host",
    redirect(302, "https://example.com/coreweave/cwic/releases/tag/v1.46.0"),
    /Invalid latest release redirect/,
  ],
  [
    "wrong repo",
    redirect(302, "https://github.com/other/cwic/releases/tag/v1.46.0"),
    /Invalid latest release redirect/,
  ],
  [
    "invalid tag",
    redirect(302, "https://github.com/coreweave/cwic/releases/tag/%3E%3D1.0"),
    /Invalid latest release redirect/,
  ],
  [
    "empty tag",
    redirect(302, "https://github.com/coreweave/cwic/releases/tag/"),
    /Invalid latest release redirect/,
  ],
  [
    "query string",
    redirect(
      302,
      "https://github.com/coreweave/cwic/releases/tag/v1.46.0?unexpected",
    ),
    /Invalid latest release redirect/,
  ],
]) {
  test(`fails clearly for ${name}`, async (t) => {
    const { deps, calls } = await fixture(t);
    deps.client.get = async () => response;
    await run(deps);
    assert.match(calls.failures[0], message);
    assert.deepEqual(calls.paths, []);
    assert.deepEqual(calls.outputs, []);
    assert.deepEqual(calls.downloads, []);
  });
}

test("resolves encoded tags in relative latest redirects and drains the response", async (t) => {
  const { deps } = await fixture(t);
  const response = redirect(
    302,
    "/coreweave/cwic/releases/tag/preview%2Fv2.0.0",
  );
  response.readBody = t.mock.fn(async () => "");
  deps.client.get = async () => response;
  assert.equal(await resolveRelease("latest", deps.client), "preview/v2.0.0");
  assert.equal(response.readBody.mock.callCount(), 1);
});

test("fails clearly for latest resolution network errors", async (t) => {
  const { deps, calls } = await fixture(t);
  deps.client.get = async () => {
    throw new Error("connection refused");
  };
  await run(deps);
  assert.match(calls.failures[0], /resolve CWIC release.*connection refused/);
  assert.deepEqual(calls.downloads, []);
});

for (const asset of [assetName, "checksums.txt"]) {
  test(`reports an unavailable release asset ${asset} and cleans up`, async (t) => {
    const { deps, calls, tempDir } = await fixture(t, "v0.0.0-unavailable");
    const download = deps.toolCache.downloadTool;
    deps.toolCache.downloadTool = async (url, destination) => {
      if (url.endsWith(asset))
        throw Object.assign(new Error("Unexpected HTTP response: 404"), {
          httpStatusCode: 404,
        });
      return download(url, destination);
    };
    await run(deps);
    assert.match(calls.failures[0], /release or asset.*not found/i);
    assert.equal(deps.client.get.mock.callCount(), 0);
    assert.deepEqual(calls.extractions, []);
    assert.deepEqual(calls.paths, []);
    assert.deepEqual(calls.outputs, []);
    assert.deepEqual(await readdir(tempDir), []);
  });
}

test("accepts standard text and binary SHA-256 checksum lines", async (t) => {
  const { tempDir } = await fixture(t);
  const file = path.join(tempDir, "archive");
  await writeFile(file, archive);
  for (const separator of ["  ", " *"]) {
    await verifyChecksum(
      file,
      `${digest.toUpperCase()}${separator}${assetName}\r\n`,
      assetName,
    );
  }
});

for (const [name, checksums, message] of [
  ["mismatch", `${"0".repeat(64)}  ${assetName}`, /Checksum mismatch/],
  ["missing", `${digest}  other.tar.gz`, /Missing or invalid checksum/],
  ["malformed", `not-a-hash  ${assetName}`, /Missing or invalid checksum/],
  [
    "duplicate",
    `${digest}  ${assetName}\n${digest}  ${assetName}`,
    /Missing or invalid checksum/,
  ],
]) {
  test(`rejects ${name} checksums before extraction and cleans up`, async (t) => {
    const { deps, calls, tempDir } = await fixture(t);
    const download = deps.toolCache.downloadTool;
    deps.toolCache.downloadTool = async (url, destination) => {
      if (url.endsWith("checksums.txt")) {
        await writeFile(destination, checksums);
        return destination;
      }
      return download(url, destination);
    };
    await run(deps);
    assert.match(calls.failures[0], message);
    assert.deepEqual(calls.extractions, []);
    assert.deepEqual(calls.paths, []);
    assert.deepEqual(calls.outputs, []);
    assert.deepEqual(await readdir(tempDir), []);
  });
}

for (const failure of [
  "archive",
  "checksums",
  "extraction",
  "missing binary",
  "symlink binary",
]) {
  test(`handles ${failure} failures without exposing an installation`, async (t) => {
    const { deps, calls, tempDir } = await fixture(t);
    if (failure === "archive" || failure === "checksums") {
      const download = deps.toolCache.downloadTool;
      deps.toolCache.downloadTool = async (url, destination) => {
        if (url.endsWith("checksums.txt") === (failure === "checksums"))
          throw new Error("download failed");
        return download(url, destination);
      };
    } else {
      deps.toolCache.extractTar = async (_, destination) => {
        if (failure === "extraction") throw new Error("invalid archive");
        if (failure === "symlink binary")
          await symlink("/does-not-exist", path.join(destination, "cwic"));
        return destination;
      };
    }
    await run(deps);
    assert.equal(calls.failures.length, 1);
    assert.match(calls.failures[0], /download|extract|binary/i);
    assert.deepEqual(calls.paths, []);
    assert.deepEqual(calls.outputs, []);
    assert.deepEqual(await readdir(tempDir), []);
  });
}
