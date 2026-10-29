# BlueExif tasks; `just` lists them.
#
#   just deploy   — npm ci, then infra/deploy.sh: build the single-file
#                   blueexif.html, deploy storage, upload it, deploy Front Door
#
# SUBSCRIPTION, RG, PREFIX and LOCATION in the environment override the
# defaults in infra/deploy.sh, e.g. `RG=rg-other just deploy`.

set shell := ["bash", "-euo", "pipefail", "-c"]

root := justfile_directory()

# List the recipes (so a bare `just` never deploys).
default:
    @just --list

# Install the locked dependencies, build, and publish to Azure.
deploy:
    npm --prefix "{{ root }}" ci
    "{{ root }}/infra/deploy.sh"
