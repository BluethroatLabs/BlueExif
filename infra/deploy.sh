#!/usr/bin/env bash
# Build the single-file blueexif.html, publish it to a storage static website,
# then put Front Door in front. Needs Node dependencies installed (npm ci) and
# an az login.
#
#   ./infra/deploy.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SUBSCRIPTION="${SUBSCRIPTION:-1e238434-310b-4bcd-ab1f-a9381d170243}"
RG="${RG:-rg-blueexif-wehi-sandbox}"
PREFIX="${PREFIX:-blueexif}"
LOCATION="${LOCATION:-centralindia}"
DEPLOYMENT="${PREFIX}-static"

az account set --subscription "$SUBSCRIPTION"

echo "Building dist-single/blueexif.html..."
npm --prefix "$ROOT" run build:single

if [[ "$(az group exists --name "$RG")" != "true" ]]; then
  # Same tags as the other Bluethroat sandbox groups; cloud-sweep=keep spares it from cleanup.
  echo "Creating resource group ${RG}..."
  az group create \
    --name "$RG" \
    --location "$LOCATION" \
    --tags active=true cloud-sweep=keep owner=wehi project="$PREFIX" \
    --output none
fi

deploy_storage() {
  az deployment group create \
    --resource-group "$RG" \
    --name "$DEPLOYMENT" \
    --template-file "$ROOT/infra/main.bicep" \
    --parameters \
      prefix="$PREFIX" \
      location="$LOCATION" \
      deployFrontDoor=false \
    --query "properties.outputs" \
    --output json
}

echo "Deploying storage account..."
OUTPUTS="$(deploy_storage)"
ACCOUNT="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["storageAccountName"]["value"])' "$OUTPUTS")"
ORIGIN_URL="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["staticWebsiteUrl"]["value"])' "$OUTPUTS")"

AUTH=(--account-name "$ACCOUNT" --auth-mode key)
echo "Enabling static website on ${ACCOUNT}..."
az storage blob service-properties update \
  "${AUTH[@]}" \
  --static-website \
  --index-document index.html \
  --output none

# The site is the single-file build, so the page a visitor saves is the whole
# app and runs offline. It goes up twice: as the page, and as a download.
upload() {
  az storage blob upload \
    "${AUTH[@]}" \
    --container-name '$web' \
    --file "$ROOT/dist-single/blueexif.html" \
    --content-type 'text/html; charset=utf-8' \
    --content-cache-control 'public, max-age=0, must-revalidate' \
    --overwrite \
    --output none \
    "$@"
}

echo "Uploading blueexif.html to \$web..."
upload --name blueexif.html --content-disposition 'attachment; filename="blueexif.html"'
upload --name index.html

while IFS= read -r blob; do
  case "$blob" in
    '' | index.html | blueexif.html) ;;
    *)
      echo "Removing stale blob ${blob}"
      az storage blob delete \
        "${AUTH[@]}" \
        --container-name '$web' \
        --name "$blob" \
        --output none
      ;;
  esac
done < <(az storage blob list "${AUTH[@]}" --container-name '$web' --query '[].name' --output tsv)

echo "Checking origin ${ORIGIN_URL}..."
curl -fsS -o /dev/null --max-time 30 "${ORIGIN_URL}"

echo "Deploying Front Door..."
fd_err="$(mktemp)"
set +e
FD_OUTPUTS="$(az deployment group create \
  --resource-group "$RG" \
  --name "$DEPLOYMENT" \
  --template-file "$ROOT/infra/main.bicep" \
  --parameters \
    prefix="$PREFIX" \
    location="$LOCATION" \
    deployFrontDoor=true \
  --query "properties.outputs" \
  --output json 2>"$fd_err")"
FD_STATUS=$?
set -e

if [[ "$FD_STATUS" -ne 0 ]]; then
  cat "$fd_err" >&2
  rm -f "$fd_err"
  echo
  echo "Front Door was blocked. Storage origin is live:"
  echo "  ${ORIGIN_URL}"
  echo
  echo "If a policy on ${RG} denies Microsoft.Cdn, ask its owner to allow:"
  echo
  cat <<'EOF'
  Microsoft.Cdn/profiles
  Microsoft.Cdn/profiles/afdendpoints
  Microsoft.Cdn/profiles/afdendpoints/routes
  Microsoft.Cdn/profiles/customdomains
  Microsoft.Cdn/profiles/origingroups
  Microsoft.Cdn/profiles/origingroups/origins
  Microsoft.Cdn/profiles/rulesets
  Microsoft.Cdn/profiles/rulesets/rules

BlueExif is a static site on Microsoft.Storage; Front Door profiles use
location "global". Contributor on the resource group is enough to deploy them.
EOF
  exit 1
fi
rm -f "$fd_err"

read_output() {
  python3 -c 'import json,sys; print(json.loads(sys.argv[1])[sys.argv[2]]["value"])' "$FD_OUTPUTS" "$1"
}
FD_URL="$(read_output frontDoorUrl)"
FD_HOST="$(read_output frontDoorHostName)"
CUSTOM_HOST="$(read_output customDomainHostName)"
DNS_TOKEN="$(read_output customDomainValidationToken)"

echo "Waiting for Front Door to serve ${FD_URL}..."
for _ in $(seq 1 18); do
  if curl -fsS -o /dev/null --max-time 30 "$FD_URL"; then
    break
  fi
  sleep 10
done
curl -fsS -o /dev/null --max-time 45 "$FD_URL"
echo "Front Door is live: ${FD_URL}"

echo "Origin: ${ORIGIN_URL}"
echo "Front Door: ${FD_URL}"
if [[ -n "$DNS_TOKEN" ]]; then
  echo "Custom domain DNS records (until Front Door validates the domain):"
  echo "  CNAME  ${CUSTOM_HOST}  ${FD_HOST}"
  echo "  TXT    _dnsauth.${CUSTOM_HOST}  ${DNS_TOKEN}"
fi
