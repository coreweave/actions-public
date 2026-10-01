# Set up CWIC

Install [CWIC](https://github.com/coreweave/cwic) and add it to PATH for subsequent workflow steps. The action downloads a public release and verifies its archive against the release's SHA-256 `checksums.txt` before extraction.

## Usage

```yaml
jobs:
  cwic:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - name: Set up CWIC
        id: cwic
        uses: coreweave/actions-public/cwic/setup-cwic@main
        with:
          version: v1.46.0
      - run: cwic version
```

For reproducible workflows, replace `@main` with a published [actions-public release tag](https://github.com/coreweave/actions-public/releases) containing this action or a full commit SHA. The action ref selects the installer; the `version` input selects the CWIC binary independently.

Installation does not require a checkout, CoreWeave credentials, a GitHub token, or `id-token: write`. It does not log in, install the Docker credential helper, or modify CWIC, Docker, or AWS credential configuration. For authenticated commands, run your authentication step after setup, then run the desired CWIC commands. Follow the [CWIC documentation](https://github.com/coreweave/cwic#readme) for authentication options.

## Inputs and outputs

| Name      | Direction | Description                                                                                                                                                                                 |
| --------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version` | Input     | Exact public CWIC release tag (for example, `v1.46.0`) or `latest`. Defaults to `latest`, which resolves to a concrete stable release before downloading. Version ranges are not supported. |
| `version` | Output    | Resolved CWIC release tag, including its `v` prefix when present. Available as `${{ steps.cwic.outputs.version }}` with the example step ID.                                                |

## Supported runners

| Operating system | Architectures                   |
| ---------------- | ------------------------------- |
| Linux            | x86_64 (`x64`), ARM64 (`arm64`) |
| macOS            | x86_64 (`x64`), ARM64 (`arm64`) |

Self-hosted runners need a GitHub Actions runner supporting Node.js 24, `tar` with gzip support, a writable `RUNNER_TEMP`, and HTTPS access to GitHub release pages and downloads. Setup resolves `latest` through GitHub's public release redirect and downloads exact tags directly, without using the GitHub REST API.

Each invocation installs into a new directory under `RUNNER_TEMP`, without `sudo` or persistent caching. The selected binary takes precedence on PATH; an existing CWIC installation is left on disk. Unsupported runners, missing releases/assets, download failures, and checksum mismatches fail the action.

## Development

From this directory, using Node.js 24:

```sh
npm ci
npm test
npm run format:check
npm run package
npm run integration
```

Commit `compiled/index.cjs` together with source changes. Unit tests use Node's test runner with mocked network/toolkit boundaries and real temporary files. Integration tests run the committed bundle, download actual public releases, execute `cwic version`, and check that credential files remain unchanged. CI checks formatting and bundle reproducibility and exercises all four supported OS/architecture combinations.
