# Get GitHub OIDC Token
Interact with the GitHub OIDC provider and get a JWT ID token.

Useful to gain access token from third parties with OIDC integrations.

### Outputs

- `id_token_default` - ID token obtained from GitHub's OIDC provider with default audience
- `id_token_audience` - ID token obtained from GitHub's OIDC provider with custom audience. Empty string if no input audience is specified.

### Usage

> [!WARNING]
> Do not share token output between workflow jobs!

> [!IMPORTANT]
> You must give the job [`id-token: write` permissions][idtokenperms] to interact with GitHub's OIDC provider.

```yaml
- uses: coreweave/actions-public/tools/oidc/github-token@main
  with:
    # Description: Audience for which the ID token is intended for.
    # Required: false
    # Default: ''
    audience: ''
```

[idtokenperms]: https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect#adding-permissions-settings
