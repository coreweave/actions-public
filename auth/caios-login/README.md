# CAOIS Login

This action allows Github Actions to authenticate to [CAIOS](https://docs.coreweave.com/docs/products/storage/object-storage/about) using OIDC authentication. Using this will set either the `default` AWS profile, or a named `profile` if provided. You can then use this profile to authenticate.

## Example Usage

> [!IMPORTANT]  
> Don't forget to include the `id-token: write` permission, otherwise you will not be able to authenticate!

```yaml
jobs:
  # This is necessary! It can be set at either the workflow or the job level.
  list-buckets:
    permissions:
      id-token: write
    ...
    steps:
    ...
    - name: Test CAIOS Action
      uses: coreweave/actions-public/auth/caois/.github/actions/caios-login@v1.1.0
      with:
        region: US-EAST-04A
        org-id: cweeee
        audience: "https://coreweave.com/iam"
        profile: caios
    
    - name: Test CAIOS Interaction
      run: |
        aws s3 ls
      env:
        AWS_PROFILE: caios
```

# Prerequisites 

In order to use `caios-login`, you must first:

1. In the [Cloud Console](https://console.coreweave.com/), under **IAM** Enable **Workload Federation (OIDC)** to Github Actions.
  - Unless you are using Github Enterprise Server (GHE), your `Issuer` will be `https://token.actions.githubusercontent.com`. You can use a custom audience, or use the default `https://coreweave.com/iam`.
  
2. In the [Cloud Console](https://console.coreweave.com/), under **Object Storage > Organization Policies** you need at least one policy to grant access to `cwobject:CreateAccessKeyOIDC`. The following policy is an example grants access to the `prod` [Environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) of the Github repo `octo-org/octo-repo`:

```json
{
  "name": "github-actions-main",
  "version": "v1alpha1",
  "statements": [
    {
      "name": "default-list",
      "effect": "Allow",
      "actions": [
        "s3:ListBucket",
        "s3:ListAllMyBuckets",
        "cwobject:CreateAccessKey*",
        "cwobject:ListAccessPolicy",
        "s3:CreateBucket"
      ],
      "resources": [
        "*"
      ],
      "principals": [
        "role/https://token.actions.githubusercontent.com:repo:octo-org/octo-repo:environment:prod"
      ]
    }
  ]
}
```

The `Principal` here is `role/<Issuer>:<Subject>`. The `Issuer` is likely `https://token.actions.githubusercontent.com`. The `Subject` can be adapted to your purposes. For a more complete reference on Github OIDC Subjects, see [the Github Documentation on OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect).

# Usage

```yaml
-  uses: coreweave/actions-public/auth/caois/.github/actions/caios-login@main
   with:
     # CoreWeave Region to use, for example "US-EAST-04A". For a list of regions, 
     # see https://docs.coreweave.com/docs/platform/regions/about-regions-and-azs
     # 
     # Required: true
     region: ''
       
     # CoreWeave Organization ID (OrgID) to to use, for example "cw1234"
     # 
     # Required: true
     org-id: ''
       
     # Which "Profile" in your ~/.aws/config file to configure. If you don't
     # know what this is, you probably want to leave it blank and use the default.
     # See https://docs.aws.amazon.com/cli/v1/userguide/cli-configure-files.html
     # 
     # Required: false
     # Default: ''
     profile: ''
   
     # Which Audience to use in the Github ID token to authenticate.
     # This value is set in the CoreWeave Cloud Console IAM settings,
     # under "Workload Federation (OIDC)", and the issuer will be
     # "https://token.actions.githubusercontent.com" unless using
     # Github Enterprise Server (GSE).
     # 
     # Required: false
     # Default: https://coreweave.com/iam
     audience: "https://coreweave.com/iam"
       
     # The S3 Endpoint to use. For GitHub-Hosted Runners, leave as the default.
     # If your are running GitHub-Actions runners inside of CKS with LOTA enabled,
     # then you will want to switch this to http://cwlota.com to take advantage of
     # the performance benefits that come from Local Object Transfer Acceleration.
     #  
     # Required: false
     # Default: https://cwobject.com
     s3-endpoint: "https://cwobject.com"
       
     # ADVANCED: YOU PROBABLY SHOULD NOT CHANGE THIS.
     # Set the Credentials Endpoint request credentials from.
     # 
     # Required: false
     # Default: https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc
     oidc-endpoint: "https://api.coreweave.com/v1/cwobject/temporary-credentials/oidc"
```
