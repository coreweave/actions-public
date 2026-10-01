# CWCR Login

Authenticate GitHub Actions to CoreWeave Container Registry (CWCR) using the workflow's OIDC identity.

After this action runs, `docker`, `buildx`, `crane`, `oras`, and other Docker-compatible tools can push to and pull from the registry for the rest of the job.

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
      - uses: actions/checkout@v4

      - name: Log in to CWCR
        uses: coreweave/actions-public/auth/cwcr-login@main
        with:
          registry: acme.cwcr.io
          audience: cwcr-acme

      - uses: docker/setup-buildx-action@v3

      - uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: acme.cwcr.io/team/app:${{ github.sha }}
```

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

| Input          | Required | Default  | Description                                                                                              |
|----------------|----------|----------|----------------------------------------------------------------------------------------------------------|
| `registry`     | yes      |          | CWCR registry host, e.g. `acme.cwcr.io`                                                                  |
| `audience`     | yes      |          | Audience requested in the GitHub OIDC token; must match the Workload Federation config, e.g. `cwcr-acme` |
| `cwic-version` | no       | `latest` | [cwic](https://github.com/coreweave/cwic/releases) release tag to install                                |

## Requirements

Runs on Linux and macOS runners (x64 and arm64) with `bash`, `curl`, and `jq` available, which includes all GitHub-hosted runners.

## Persistent runners

On a persistent runner, use a dedicated job account or run cwic registry credential-helper unconfigure acme.cwcr.io after use with the same DOCKER_CONFIG setting to remove the binding and its CWIC Docker helper entry; the saved command requires an active GitHub job environment.
