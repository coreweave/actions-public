> [!WARNING]
> Kaniko is [no longer maintained][kaniko deprecation] (as of 2024-10-16). Although it may continue to work for the foreseeable future, it's possible bugs or unexpected behavior may show up, and there is no guarantee that those will be fixed.

# `kaniko` Build & Push Action
A CoreWeave Action that uses the [`kaniko`][kaniko-page] executor to build and push an image to a container registry.

## Overview
`kaniko` executes commands within a Dockerfile completely in userspace. You can build container images in environments that can't securely run a Docker daemon, such as a standard Kubernetes cluster.

> [!IMPORTANT]
> Kaniko does not support Dockerfile syntax v1.2 or above.


## Usage
> [!NOTE]
> If `docker-config` is not provided, `registry`, `username` and `password` will be used for authentication. `username` and `password` credentials should be stored as [repository secrets](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions).
>
>If `docker-config` input is provided, it will be used as the default regardless of registry authentication inputs.
>
>If you need to authenticate with *more than one registry*, you must use the `docker-config` input. See [this section](./README.md#authenticating-to-multiple-container-registries) for more details.

For an exhaustive list of options you can provide to `kaniko-args:`, please reference the [`kaniko` flags docs][].

```yaml
- uses: coreweave/actions-public/build/kaniko-build@main
  with:
    # Description: A directory containing a Dockerfile which kaniko will use to build your image.
    # Required: true
    # Default: ""
    context: ""

    # Description: A comma- or newline-separated list of tags.
    # Required: true
    # Default: ""
    tags: ""

    # Description: Filepath resolving to the Dockerfile to use.
    # Required: true
    dockerfile: ""

    # Description: Extra arguments to pass to the Kaniko executor.
    # Required: false
    # Default: ""
    kaniko-args: ""

    # Description: A Docker configuration file which kaniko will use to authenticate to a container registry to push your image.
    # NOTE: This option takes precedence even if username and password are provided.
    # Required: false
    # Default: ""
    docker-config: ""

    # Description: The URL to the container registry.
    # Required: false
    # Default: ""
    registry: ""

    # Description: The username to authenticate to the container registry, stored as a repository secret.
    # Required: false
    # Default: ""
    username: ${{ secrets.YOUR_REGISTRY_USERNAME }}

    # Description: The password to authenticate to the container registry, stored as a repository secret.
    # Required: false
    # Default: ""
    password: ${{ secrets.YOUR_REGISTRY_PASSWORD }}
```

## Authenticating to Multiple Container Registries

To authenticate to multiple container registries, you must create a Docker [`config.json`][dockerconfigjson] that has credentials for each container registry.


1. Generate a configuration file like the following template:

```yaml
build-and-push-image-with-docker-config:
  runs-on: ubuntu-latest
  steps:
    - name: Checkout repository
      uses: actions/checkout@v4

    - name: Create Docker config
      run: |
          mkdir -p _tmp/kaniko/.docker
          cat > _tmp/kaniko/.docker/config.json <<EOF
          {
            "auths": {
              "https://<registry-url>": {
                "username": "${{ secrets.REGISTRY_USERNAME }}",
                "password": "${{ secrets.REGISTRY_PASSWORD }}"
              },
              "https://<registry-url2>": {
                "username": "${{ secrets.REGISTRY_USERNAME2 }}",
                "password": "${{ secrets.REGISTRY_PASSWORD2 }}"
              }
            }
          }
          EOF
```


2. Pass a path to this, relative to the root of your GitHub workspace.
```yaml
- name: Kaniko Build & Push
  uses: coreweave/actions-public/build/kaniko-build@main
  with:
    docker-config: _tmp/kaniko/.docker/config.json
```


## Additional Reading

For more information on advanced usage of Docker's `config.json`, please refer to:
* [Docker's specification on syntax for Docker's registry authentication files][dockerspecreg]
* [the Docker CLI documentation][dockerclidoc]
* [Google Cloud's documentation on different `auth` settings][authsettings]
* [`docker login` documentation on authentication implementation details][dockerlogin]

[`kaniko` flags docs]: https://github.com/GoogleContainerTools/kaniko?tab=readme-ov-file#additional-flags
[kaniko deprecation]: https://github.com/GoogleContainerTools/kaniko/issues/3348
[dockerconfigjson]: https://docs.docker.com/engine/reference/commandline/cli/#configjson-properties
[dockerspecreg]: https://github.com/containers/image/blob/main/docs/containers-auth.json.5.md
[dockerclidoc]: https://docs.docker.com/reference/cli/docker/login/#privileged-user-requirement
[authsettings]: https://cloud.google.com/artifact-registry/docs/docker/authentication#docker-config
[dockerlogin]: https://docs.docker.com/reference/cli/docker/login/#privileged-user-requirement
[kaniko-page]: https://github.com/GoogleContainerTools/kaniko
