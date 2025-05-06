# `buildx` Build & Push Action
A CoreWeave Action that uses [`buildx` via BuildKit][buildx-link] to build an image and push it to a container registry.

This supports the latest Docker features and multi-arch image builds.

## Usage
> [!NOTE]
> If `docker-config` is not provided, `registry`, `username` and `password` will be used for authentication. `username` and `password` credentials should be stored as [repository secrets][repo-secrets-link].
>
> If `docker-config` input is provided, it will be used as the default regardless of registry authentication inputs.
>
> If you need to authenticate with *more than one registry*, you must use the `docker-config` input.

For an exhaustive list of options you can provide to `buildx-args:`, please reference the [`buildx build` options docs][].

```yaml
- uses: coreweave/actions-public/build/buildx-build@main
  with:
    # Description: A directory containing a Dockerfile which buildx will use to build your image.
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

    # Description: The BuildKit endpoint to connect to (ie. tcp://buildkitd.namespace:1234).
    # Required: true
    # Default: ""
    endpoint: ""

    # Description: Additional endpoints to append to the builder, YAML string
    # Required: false
    # Default: ""
    append: ""

    # Description: Extra arguments to pass to the `buildx build` command.
    # Required: false
    # Default: ""
    buildx-args: ""

    # Description: A Docker configuration file which buildx will use to authenticate to a container registry to push your image.
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

    # Description: The Doppler token to fetch the BuildKit client certs.
    # NOTE: This should be stored as a repo secret (unless using an org-wide secret).
    # Required: true
    # Default: ""
    doppler-token: ""

    # Description: The Doppler project to fetch the BuildKit client certs.
    # Required: true
    # Default: ""
    doppler-project: ""

    # Description: The Doppler config to fetch the BuildKit client certs (e.g. prod).
    # Required: true
    # Default: ""
    doppler-config: ""
```

## Append BuildKit Nodes to Builder
You can specify more than 1 builder node in order to build your image. This is particularly useful when doing multi-arch builds, where
one builder is `amd64` native and the other is `arm64` native.

### Multiple Endpoints Example
In our action implementation, all builder nodes will share the same mTLS client certificates. You can specify additional endpoints by filling in
the `append:` input to the action. See ["Append additional nodes to the builder" BuildKit docs][append-builder-docs] for more detailed information.

This will add three nodes to the builder *(the third endpoint is simply used as an example to illustrate providing a YAML list)*:
```yaml
- name: Build & Push Image (BuildKit)
  uses: coreweave/actions-public/build/buildx-build@main
  with:
    endpoint: tcp://buildkitd-amd64.namespace:1234
    append: |
      - endpoint: tcp://buildkitd-arm64.namespace:1234
      - endpoint: tcp://buildkitd-a-third-arch.namespace:1234
```

## Authenticating to Multiple Container Registries

To authenticate to multiple container registries, you must create a Docker [`config.json`][docker-config-link] that has credentials for each container registry.

1. Generate a configuration file like the following template:

```yaml
build-and-push-image-with-docker-config:
  runs-on: ubuntu-latest
  steps:
    - name: Checkout repository
      uses: actions/checkout@v4

    - name: Create Docker config
      run: |
          mkdir -p _tmp/buildkit/.docker
          cat > _tmp/buildkit/.docker/config.json <<EOF
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
- name: BuildKit Build & Push
  uses: coreweave/actions-public/build/buildx-build@main
  with:
    docker-config: _tmp/buildkit/.docker/config.json
```

## Doppler Integration
This action requires that several client-side mTLS certificates be stored in Doppler with
the following names for BuildKit to use during mutual authentication.
 - `TLS_CACERT`
 - `TLS_CERT`
 - `TLS_KEY`


[buildx-link]: https://github.com/docker/buildx
[repo-secrets-link]: https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions
[docker-config-link]: https://docs.docker.com/engine/reference/commandline/cli/#configjson-properties
[`buildx build` options docs]: https://github.com/docker/buildx/blob/master/docs/reference/buildx_build.md#options
[secret-mounts-docs-link]: https://docs.docker.com/build/building/secrets/#secret-mounts
[append-builder-docs]: https://docs.docker.com/build/ci/github-actions/configure-builder/#append-additional-nodes-to-the-builder
