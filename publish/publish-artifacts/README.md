# Publish Artifacts

Upload release files to a CoreWeave Artifactory repository from a public
repository. The action exchanges the job's GitHub OIDC token for a short-lived
Artifactory token, so the repository stores no secret.

Supported `package-type` values:

| Type | Files | Notes |
|---|---|---|
| `debian` | `.deb` | Indexed under `deb-distribution`/`deb-component`/architecture. The architecture is read from each file name unless `deb-architecture` is set. |
| `generic` | any | Uploaded as is. |
| `helm` | chart `.tgz` | Artifactory updates the chart index. |
| `npm` | package `.tgz` | Artifactory reads the package metadata. |
| `pypi` | wheels and sdists | Artifactory reads the package metadata. |

Container images are not supported; push them with a registry client instead.

## Before you start

Publishing needs three things set up by CoreWeave's Developer Experience team:

- the target repository,
- a JFrog OIDC provider whose identity mapping trusts your repository, and
- for public downloads, anonymous read on the repository.

Ask for the identity mapping to be pinned to your release branch and release
environment, not only to the repository. Then only the gated release job below
can upload.

## Usage

Run the upload in its own job, behind a protected
[environment](https://docs.github.com/actions/deployment/targeting-different-environments/using-environments-for-deployment)
with required reviewers. Grant `id-token: write` to that job only.

```yaml
permissions:
  contents: read

jobs:
  publish:
    runs-on: cw-static-pub-x64-4c
    environment: release
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@<sha>
        with:
          persist-credentials: false

      # ... build dist/*.deb, for example with GoReleaser ...

      - uses: coreweave/actions-public/publish/publish-artifacts@<sha>
        with:
          package-type: debian
          repository: ${{ vars.ARTIFACTORY_REPOSITORY }}
          files: dist/*.deb
          deb-distribution: stable
          oidc-provider-name: ${{ vars.ARTIFACTORY_OIDC_PROVIDER_NAME }}
          oidc-audience: ${{ vars.ARTIFACTORY_OIDC_AUDIENCE }}
```

`files` takes one pattern per line. Every pattern must match at least one file,
and a file matched twice is uploaded once:

```yaml
          package-type: generic
          target-path: releases/${{ github.ref_name }}
          files: |
            dist/*.tar.gz
            dist/checksums.txt
          properties: release=${{ github.ref_name }}
```

Set `dry-run: 'true'` to validate the inputs and print the upload plan without
authenticating or uploading. A dry run needs no OIDC inputs.

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `package-type` | yes | | `debian`, `generic`, `helm`, `npm` or `pypi`. |
| `repository` | yes | | Artifactory repository key. |
| `files` | yes | | Newline-separated files or glob patterns, relative to the workspace. `**` matches nested directories. |
| `target-path` | no | `pool/<deb-component>` for debian, repository root otherwise | Directory inside the repository. |
| `deb-distribution` | debian only | | Distribution, such as `stable`. |
| `deb-component` | no | `main` | Component. |
| `deb-architecture` | no | from file name | Architecture for every file. |
| `properties` | no | | Extra properties, as `key1=value1;key2=value2`. |
| `jfrog-url` | no | `https://coreweave.jfrog.io` | JFrog platform URL. |
| `oidc-provider-name` | unless dry run | | JFrog OIDC provider name. |
| `oidc-audience` | unless dry run | | Audience the provider expects. |
| `dry-run` | no | `false` | Plan only. |

## Outputs

| Output | Description |
|---|---|
| `count` | Number of files uploaded, or planned in a dry run. |
| `files` | Newline-separated list of those files. |

## Installing a published Debian package

Use the repository's published signing key URL in place of `<public-key-url>`:

```sh
curl -fsSL <public-key-url> | sudo gpg --dearmor -o /usr/share/keyrings/coreweave.gpg
echo "deb [signed-by=/usr/share/keyrings/coreweave.gpg] https://artifacts.coreweave.com/artifactory/api/deb/<repository> stable main" \
  | sudo tee /etc/apt/sources.list.d/coreweave.list
sudo apt-get update && sudo apt-get install <package>
```
