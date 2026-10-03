# CAIOS Login v2

Authenticate GitHub Actions to [CAIOS](https://docs.coreweave.com/docs/products/storage/object-storage/about) using OIDC and automatically refreshed AWS profile credentials.

## Setup

In the [Cloud Console](https://console.coreweave.com/), enable GitHub **Workload Federation (OIDC)** under **IAM**. Under **Object Storage > Organization Policies**, grant your workflow's OIDC principal `cwobject:CreateAccessKeyOIDC` and the S3 permissions it needs.

For the `prod` environment in `octo-org/octo-repo`, a name-based principal is:

```text
role/https://token.actions.githubusercontent.com:repo:octo-org/octo-repo:environment:prod
```

> [!NOTE]
> On GitHub.com, repositories created, renamed, or transferred after July 15, 2026 use [immutable subject claims](https://github.blog/changelog/2026-04-23-immutable-subject-claims-for-github-actions-oidc-tokens/), such as `repo:octo-org@123/octo-repo@456:environment:prod`, where `123` and `456` are GitHub owner and repository IDs. Unchanged existing repositories retain the name-based format unless they opt in. Match your policy principal to your workflow's actual `sub` claim.

Adapt this to your workflow's [OIDC subject](https://docs.github.com/en/actions/concepts/security/openid-connect), and match the `audience` input to your federation settings.

The runner needs CWIC v1.37.0 or newer, `/bin/sh`, `/usr/bin/env`, `curl`, `sed`, and Node.js 24 action support. Install CWIC first and grant the job `id-token: write`:

```yaml
jobs:
  list-buckets:
    runs-on: ubuntu-24.04
    environment: prod
    permissions:
      id-token: write
    steps:
      - uses: coreweave/actions-public/cwic/setup-cwic@main
        with:
          version: v1.46.0

      - uses: coreweave/actions-public/auth/caios-login-v2@main
        with:
          region: US-EAST-04A
          org-id: cw123456
          profile: caios

      - run: aws s3 ls --profile caios
```

Replace `@main` with a release tag containing these actions or a commit SHA to pin the action versions.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `region` | Required | CoreWeave region, e.g. `US-EAST-04A`. |
| `org-id` | Required | CoreWeave organization ID. |
| `profile` | `default` | AWS profile to configure. |
| `config_file` | `~/.aws/config` | AWS config file to update and export as `AWS_CONFIG_FILE`. |
| `audience` | `https://coreweave.com/iam` | OIDC audience configured in IAM. |
| `s3-endpoint` | `https://cwobject.com` | Use `http://cwlota.com` on CKS with LOTA enabled. |
| `oidc-endpoint` | `https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc` | Only the API origin may change; keep the path shown. |

## Profile behavior

Omit `profile` to configure the default profile. This clears existing static AWS credentials and web-identity environment variables so they cannot override CAIOS authentication.

For named profiles, use `aws --profile caios` as shown above. You can also set `AWS_PROFILE=caios`, but existing static credentials or web-identity environment variables can take precedence.

The action replaces the selected profile in `config_file`, preserving other profiles. Use `config_file: ${{ runner.temp }}/caios-config` for a separate file. Existing settings in the selected profile are discarded; add any custom settings after login.

The original shared credentials file is untouched. Post-job cleanup removes the temporary credential helper, cache, and filtered credentials file. Config and profile selection remain as configured.
