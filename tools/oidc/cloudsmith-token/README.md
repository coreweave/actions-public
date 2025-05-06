# Get Cloudsmith API Token from OIDC Token
Action to obtain a Cloudsmith API Token (API key) for a service account from an OIDC token.

### Usage
> [!NOTE]
> This action sets `CLOUDSMITH_API_TOKEN` environment variable for use in subsequent steps to authenticate with Cloudsmith.

```yaml
- uses: coreweave/actions-public/tools/oidc/cloudsmith-token@main
  with:
    # Description: OIDC token (this should be masked).
    # Required: true
    oidc-token: ''

    # Description: Cloudsmith organization.
    # Required: true
    # Default: 'coreweave'
    cloudsmith-org: ''

    # Description: Cloudsmith service account slug (service account name).
    # Required: true
    cloudsmith-service-slug: ''
```
