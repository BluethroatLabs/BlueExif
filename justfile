# BlueExif tasks; `just` lists them.
#
#   just deploy   — npm ci, then infra/deploy.sh: build the single-file
#                   blueexif.html, deploy its storage in BlueMask's group,
#                   upload it, add it to the shared Front Door profile
#
# SUBSCRIPTION, RG, PREFIX, LOCATION and DEPLOY_FRONT_DOOR in the environment
# override the defaults in infra/deploy.sh, e.g. `DEPLOY_FRONT_DOOR=false just deploy`.

set shell := ["bash", "-euo", "pipefail", "-c"]

root := justfile_directory()

# List the recipes (so a bare `just` never deploys).
default:
    @just --list

# Install the locked dependencies, build, and publish to Azure.
deploy:
    npm --prefix "{{ root }}" ci
    "{{ root }}/infra/deploy.sh"
