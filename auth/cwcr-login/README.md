# CWCR Login

Authenticate GitHub Actions to CoreWeave Container Registry (CWCR) using the workflow's OIDC identity.

After this action runs, Docker-compatible tools in the same job authenticate to the registry automatically. What they can do there is governed by the access granted to the workflow's identity in the registry's access configuration.

## Example Usage

> [!IMPORTANT]
> Don't forget to include the `id-token: write` permission, otherwise you will not be able to authenticate!

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    # This is necessary! It can be set at either the workflow or the job level.
    permissions:
      contents: read
      id-token: write

    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0

      - name: Set up CWIC
        uses: coreweave/actions-public/cwic/setup-cwic@6b225e30df11c646ddee8641565935318f0918f0 # v1.2.0

      - name: Log in to CWCR
        uses: coreweave/actions-public/auth/cwcr-login@main
        with:
          registry: acme.cwcr.io
          audience: cwcr-acme

      - uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3.12.0

      - uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6.19.2
        with:
          context: .
          push: true
          tags: acme.cwcr.io/team/app:${{ github.sha }}
```

For reproducible workflows, replace `@main` with a published [actions-public release tag](https://github.com/coreweave/actions-public/releases) containing this action or a full commit SHA.

## Prerequisites

1. **Register GitHub as a Workload Federation issuer** for the organization that owns the namespace, with a dedicated audience for this registry.

```bash
cwic iam workload-federation oidc create --name cwcr-acme-github \
  --issuer-url https://token.actions.githubusercontent.com \
  --audience cwcr-acme \
  --description 'GitHub Actions identities for acme CWCR'
```

2. **Grant the workflow access** in the namespace access configuration. For example:

```yaml
id: github-app-publisher
identitySelector: REGISTRY_IDENTITY_SELECTOR_WORKLOAD_FEDERATION
rules:
  - id: publish-app
    expression: >-
      identity["issuer"] == "https://token.actions.githubusercontent.com" &&
      "cwcr-acme" in identity["audiences"] &&
      identity["claims"]["repository_id"] == "123456789" &&
      identity["claims"]["ref"] == "refs/heads/main" &&
      identity["claims"]["workflow_ref"] == "acme/app/.github/workflows/publish.yml@refs/heads/main" &&
      request["type"] == "repository" &&
      request["repository"] == "team/app" &&
      request["action"] in ["pull", "push"]
```

Save the policy as `github-app-publisher.yaml` and apply it:

```bash
cwic registry namespace access policy-set update acme github-app-publisher \
  --file github-app-publisher.yaml --wait
```

For the claims available on a GitHub OIDC token, see [the GitHub documentation on OpenID Connect](https://docs.github.com/en/actions/reference/security/oidc).

## Inputs

| Input      | Required | Default | Description                                                                                              |
| ---------- | -------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `registry` | yes      |         | CWCR registry host, e.g. `acme.cwcr.io`                                                                  |
| `audience` | yes      |         | Audience requested in the GitHub OIDC token; must match the Workload Federation config, e.g. `cwcr-acme` |

## Supported runners

| Operating system | Architectures                   |
| ---------------- | ------------------------------- |
| Linux            | x86_64 (`x64`), ARM64 (`arm64`) |
| macOS            | x86_64 (`x64`), ARM64 (`arm64`) |

Runners need a GitHub Actions runner supporting Node.js 24, a writable `RUNNER_TEMP`, and `cwic` on PATH. Run [`setup-cwic`](../../cwic/setup-cwic/README.md) first; this action does not install CWIC.

Each invocation installs the Docker credential helper into a new directory under `RUNNER_TEMP` and binds the registry to it in the Docker configuration. When the job ends, the action's post step removes the binding again, so nothing is left behind on persistent runners.

## Development

From this directory, using Node.js 24:

```sh
npm ci
npm test
npm run format:check
npm run package
npm run integration
```

Commit `compiled/` together with source changes. Unit tests use Node's test runner with mocked toolkit boundaries and real temporary files. Integration tests run the committed `compiled/token.cjs` against the job's GitHub OIDC endpoint, check the returned token's audience, and check that repeated runs return distinct tokens; they need `id-token: write` and are skipped outside GitHub Actions. CI checks formatting and bundle reproducibility and exercises all four supported OS/architecture combinations.
