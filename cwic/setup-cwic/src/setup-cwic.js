import * as core from "@actions/core";
import { HttpClient } from "@actions/http-client";
import * as toolCache from "@actions/tool-cache";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import path from "node:path";

const releases = "https://github.com/coreweave/cwic/releases";

function validTag(tag) {
  return (
    typeof tag === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tag) &&
    !/\s/.test(tag) &&
    !tag.includes("..")
  );
}

export function archiveName(platform, arch) {
  const os = { linux: "Linux", darwin: "Darwin" }[platform];
  const cpu = { x64: "x86_64", arm64: "arm64" }[arch];
  if (!os || !cpu)
    throw new Error(
      `Unsupported runner platform: ${platform}/${arch}. Supported: Linux and macOS on x64 and arm64.`,
    );
  return `cwic_${os}_${cpu}.tar.gz`;
}

export async function resolveRelease(version, client) {
  const requested = version || "latest";
  if (!validTag(requested))
    throw new Error(
      "The version input must be an exact release tag or latest; version ranges are not supported.",
    );
  if (requested !== "latest") return requested;
  let response;
  try {
    response = await client.get(`${releases}/latest`);
    await response.readBody();
  } catch (error) {
    throw new Error(
      `Failed to resolve CWIC release ${requested}: ${error.message}`,
    );
  }
  const status = response.message.statusCode;
  if (status === 404)
    throw new Error(`CWIC release ${requested} was not found.`);
  if (![301, 302, 303, 307, 308].includes(status))
    throw new Error(
      `Failed to resolve CWIC release ${requested}: HTTP ${status}.`,
    );
  try {
    const location = new URL(
      response.message.headers.location,
      `${releases}/latest`,
    );
    const prefix = "/coreweave/cwic/releases/tag/";
    const tag = decodeURIComponent(location.pathname.slice(prefix.length));
    if (
      location.origin === "https://github.com" &&
      location.pathname.startsWith(prefix) &&
      !location.search &&
      !location.hash &&
      validTag(tag)
    )
      return tag;
  } catch {
    // Only a redirect to a release tag in the public CWIC repository is valid.
  }
  throw new Error("Invalid latest release redirect received for CWIC.");
}

export async function verifyChecksum(archive, checksums, name) {
  const entries = checksums
    .split(/\r?\n/)
    .map((line) => /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line))
    .filter((match) => match?.[2] === name);
  if (entries.length !== 1)
    throw new Error(`Missing or invalid checksum for ${name}.`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== entries[0][1].toLowerCase())
    throw new Error(`Checksum mismatch for ${name}.`);
}

export async function run({
  core: toolkit = core,
  toolCache: tools = toolCache,
  client = new HttpClient("setup-cwic", [], {
    allowRetries: true,
    maxRetries: 3,
    socketTimeout: 20000,
    allowRedirects: false,
  }),
  platform = process.platform,
  arch = process.arch,
  tempDir = process.env.RUNNER_TEMP,
} = {}) {
  let workspace;
  let installed = false;
  try {
    const name = archiveName(platform, arch);
    const version = await resolveRelease(toolkit.getInput("version"), client);
    if (!tempDir)
      throw new Error(
        "RUNNER_TEMP must be set to a runner-writable directory.",
      );
    workspace = await mkdtemp(path.join(tempDir, "setup-cwic-"));
    const base = `${releases}/download/${encodeURIComponent(version)}`;
    const archive = path.join(workspace, name);
    const checksumFile = path.join(workspace, "checksums.txt");
    for (const [asset, destination] of [
      [name, archive],
      ["checksums.txt", checksumFile],
    ]) {
      try {
        await tools.downloadTool(`${base}/${asset}`, destination);
      } catch (error) {
        if (error.httpStatusCode === 404)
          throw new Error(
            `CWIC release or asset ${asset} for ${version} was not found.`,
          );
        throw new Error(
          `Failed to download CWIC ${asset} for ${version}: ${error.message}`,
        );
      }
    }
    await verifyChecksum(archive, await readFile(checksumFile, "utf8"), name);
    const extracted = path.join(workspace, "extracted");
    await mkdir(extracted);
    try {
      await tools.extractTar(archive, extracted);
    } catch (error) {
      throw new Error(`Failed to extract CWIC archive: ${error.message}`);
    }
    const source = path.join(extracted, "cwic");
    const binary = await lstat(source).catch(() => null);
    if (!binary?.isFile())
      throw new Error("CWIC archive does not contain a regular cwic binary.");
    const bin = path.join(workspace, "bin");
    await mkdir(bin);
    await copyFile(source, path.join(bin, "cwic"));
    await chmod(path.join(bin, "cwic"), 0o755);
    await rm(extracted, { recursive: true, force: true });
    await rm(archive);
    await rm(checksumFile);
    toolkit.addPath(bin);
    toolkit.setOutput("version", version);
    toolkit.info(`Installed CWIC ${version} for ${platform}/${arch}.`);
    installed = true;
  } catch (error) {
    toolkit.setFailed(`Failed to set up CWIC: ${error.message}`);
  } finally {
    client.dispose();
    if (workspace && !installed)
      await rm(workspace, { recursive: true, force: true });
  }
}
