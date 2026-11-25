#!/usr/bin/env bash
# publish-artifacts helper.
#
#   publish.sh plan    Validate the inputs, resolve the files and write the upload plan.
#                      Talks to nothing, so it also backs dry-run.
#   publish.sh upload  Upload every file in the plan with the JFrog CLI that
#                      setup-jfrog-cli configured through OIDC.
#
# All inputs arrive as environment variables set by action.yaml.
set -euo pipefail

SUPPORTED_TYPES="debian generic helm npm pypi"
NAME_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
PATH_RE='^[A-Za-z0-9._/-]+$'
PROPS_RE='^[^=;]+=[^;]*(;[^=;]+=[^;]*)*$'

fail() {
  echo "::error::$*"
  exit 1
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "${s}"
}

# Directory inside the repository that files are uploaded to, with a trailing slash.
target_dir() {
  local dir="${TARGET_PATH}"
  if [[ -z "${dir}" && "${PACKAGE_TYPE}" == "debian" ]]; then
    dir="pool/${DEB_COMPONENT}"
  fi
  if [[ -n "${dir}" ]]; then
    printf '%s/%s/' "${REPOSITORY}" "${dir%/}"
  else
    printf '%s/' "${REPOSITORY}"
  fi
}

validate_inputs() {
  case " ${SUPPORTED_TYPES} " in
    *" ${PACKAGE_TYPE} "*) ;;
    *)
      if [[ "${PACKAGE_TYPE}" == "oci" || "${PACKAGE_TYPE}" == "docker" ]]; then
        fail "package-type '${PACKAGE_TYPE}' is not supported: container images are pushed with a registry client, not uploaded as files."
      fi
      fail "package-type must be one of: ${SUPPORTED_TYPES// /, } (got '${PACKAGE_TYPE}')."
      ;;
  esac

  [[ "${REPOSITORY}" =~ ${NAME_RE} ]] \
    || fail "repository must be an Artifactory repository key such as cw-example-debian-prod-local (got '${REPOSITORY}')."

  if [[ -n "${TARGET_PATH}" ]]; then
    [[ "${TARGET_PATH}" =~ ${PATH_RE} ]] \
      || fail "target-path may only contain letters, digits, '.', '_', '-' and '/' (got '${TARGET_PATH}')."
    [[ "${TARGET_PATH}" != /* ]] || fail "target-path must be relative to the repository root."
    [[ "/${TARGET_PATH}/" != */../* ]] || fail "target-path must not contain '..'."
  fi

  if [[ -n "${PROPERTIES}" ]]; then
    [[ "${PROPERTIES}" =~ ${PROPS_RE} ]] \
      || fail "properties must be on one line, in the form key1=value1;key2=value2."
  fi

  [[ "${DRY_RUN}" == "true" || "${DRY_RUN}" == "false" ]] || fail "dry-run must be true or false."

  if [[ "${PACKAGE_TYPE}" == "debian" ]]; then
    [[ -n "${DEB_DISTRIBUTION}" ]] || fail "deb-distribution is required for package-type debian (e.g. stable)."
    [[ "${DEB_DISTRIBUTION}" =~ ${NAME_RE} ]] || fail "deb-distribution is not a valid name (got '${DEB_DISTRIBUTION}')."
    [[ "${DEB_COMPONENT}" =~ ${NAME_RE} ]] || fail "deb-component is not a valid name (got '${DEB_COMPONENT}')."
    if [[ -n "${DEB_ARCHITECTURE}" ]]; then
      [[ "${DEB_ARCHITECTURE}" =~ ${NAME_RE} ]] || fail "deb-architecture is not a valid name (got '${DEB_ARCHITECTURE}')."
    fi
  fi

  if [[ "${DRY_RUN}" == "false" ]]; then
    [[ -n "${OIDC_PROVIDER_NAME}" ]] || fail "oidc-provider-name is required unless dry-run is true."
    [[ -n "${OIDC_AUDIENCE}" ]] || fail "oidc-audience is required unless dry-run is true."
    [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]] \
      || fail "This job cannot request a GitHub OIDC token. Add 'permissions: id-token: write' to the job."
  fi
}

# Writes "<file>\t<debian architecture or empty>" per line to the plan file.
resolve_files() {
  local plan="$1" pattern line f arch base count=0 matched
  shopt -s nullglob globstar

  while IFS= read -r line || [[ -n "${line}" ]]; do
    pattern="$(trim "${line}")"
    [[ -n "${pattern}" ]] || continue
    [[ "${pattern}" != /* ]] || fail "files patterns must be relative to the workspace (got '${pattern}')."
    [[ "/${pattern}/" != */../* ]] || fail "files patterns must not contain '..' (got '${pattern}')."

    matched=0
    # Unquoted on purpose: the pattern is a glob. IFS stops it splitting on spaces.
    local IFS=$'\n'
    for f in ${pattern}; do
      [[ -f "${f}" ]] || continue
      [[ "${f}" != *$'\t'* ]] || fail "File names must not contain tabs (got '${f}')."
      matched=1
      if cut -f1 "${plan}" | grep -Fxq -- "${f}"; then
        continue
      fi

      arch=""
      if [[ "${PACKAGE_TYPE}" == "debian" ]]; then
        [[ "${f}" == *.deb ]] || fail "package-type debian only uploads .deb files (got '${f}')."
        arch="${DEB_ARCHITECTURE}"
        if [[ -z "${arch}" ]]; then
          base="$(basename "${f}")"
          if [[ "${base}" =~ _([A-Za-z0-9]+)\.deb$ ]]; then
            arch="${BASH_REMATCH[1]}"
          else
            fail "Cannot infer the architecture of '${f}' from its name (expected <name>_<version>_<arch>.deb). Set deb-architecture."
          fi
        fi
      fi

      printf '%s\t%s\n' "${f}" "${arch}" >> "${plan}"
      count=$((count + 1))
    done
    unset IFS
    (( matched )) || fail "No files match '${pattern}'."
  done <<< "${FILES}"

  (( count > 0 )) || fail "files must list at least one file to upload."
}

write_outputs() {
  local plan="$1" target f arch count
  target="$(target_dir)"
  count="$(wc -l < "${plan}" | tr -d ' ')"
  {
    echo "plan-file=${plan}"
    echo "count=${count}"
    echo "files<<PUBLISH_ARTIFACTS_EOF"
    cut -f1 "${plan}"
    echo "PUBLISH_ARTIFACTS_EOF"
  } >> "${GITHUB_OUTPUT:-/dev/null}"

  echo "Planned ${count} upload(s) to ${target}"
  while IFS=$'\t' read -r f arch; do
    if [[ -n "${arch}" ]]; then
      echo "  ${f} -> ${target} (deb ${DEB_DISTRIBUTION}/${DEB_COMPONENT}/${arch})"
    else
      echo "  ${f} -> ${target}"
    fi
  done < "${plan}"

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      if [[ "${DRY_RUN}" == "true" ]]; then
        echo "### publish-artifacts (dry run, nothing uploaded)"
      else
        echo "### publish-artifacts"
      fi
      echo
      echo "| File | Target | Debian coordinates |"
      echo "|---|---|---|"
      while IFS=$'\t' read -r f arch; do
        echo "| \`${f}\` | \`${target}\` | ${arch:+${DEB_DISTRIBUTION}/${DEB_COMPONENT}/${arch}} |"
      done < "${plan}"
    } >> "${GITHUB_STEP_SUMMARY}"
  fi
}

plan() {
  local plan
  validate_inputs
  plan="$(mktemp "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/publish-artifacts.XXXXXX")"
  resolve_files "${plan}"
  write_outputs "${plan}"
}

upload() {
  local target f arch
  local -a args
  [[ -f "${PLAN_FILE:-}" ]] || fail "The upload plan is missing. Run the plan step first."
  command -v jf > /dev/null || fail "The JFrog CLI is not on PATH."
  target="$(target_dir)"

  while IFS=$'\t' read -r f arch; do
    args=(rt upload "${f}" "${target}" --flat=true --recursive=false --fail-no-op=true)
    if [[ -n "${arch}" ]]; then
      args+=(--deb "${DEB_DISTRIBUTION}/${DEB_COMPONENT}/${arch}")
    fi
    if [[ -n "${PROPERTIES}" ]]; then
      args+=(--target-props "${PROPERTIES}")
    fi
    echo "Uploading ${f} to ${target}"
    jf "${args[@]}"
  done < "${PLAN_FILE}"
}

case "${1:-}" in
  plan) plan ;;
  upload) upload ;;
  *) fail "usage: publish.sh plan|upload" ;;
esac
