#!/usr/bin/env bash
# One Entra app per repo, trusted only for that repo's main branch, with
# Contributor on that repo's resource group. Re-running updates GitHub secrets
# and leaves existing apps, trusts, and role assignments in place.
#
# Checks every prerequisite and exits before creating anything if one is missing.
#
#   ./infra/setup-github-oidc.sh
set -euo pipefail

SUBSCRIPTION="1e238434-310b-4bcd-ab1f-a9381d170243"
ORG="BluethroatLabs"
ISSUER="https://token.actions.githubusercontent.com"
AUDIENCE="api://AzureADTokenExchange"
BRANCH="main"
# Run ./infra/deploy.sh once first: it creates the resource group.
ROWS='blueexif|github-blueexif|rg-blueexif-wehi-sandbox
'

failures=0
note() {
  echo "$1" >&2
  failures=1
}

each_row() {
  local repo app rg
  while IFS='|' read -r repo app rg <&3; do
    [[ -n "$repo" ]] || continue
    "$@" "$repo" "$app" "$rg"
  done 3<<< "$ROWS"
}

command -v az >/dev/null || note "Azure CLI (az) is not installed."
command -v gh >/dev/null || note "GitHub CLI (gh) is not installed."
if [[ "$failures" -ne 0 ]]; then
  exit 1
fi

if ! az account show --query id --output tsv >/dev/null 2>&1; then
  echo "Run az login in the tenant that contains subscription ${SUBSCRIPTION}." >&2
  exit 1
fi
az account set --subscription "$SUBSCRIPTION"
TENANT_ID="$(az account show --query tenantId --output tsv)"

if ! gh auth status >/dev/null 2>&1; then
  echo "Run gh auth login as an admin of every BluethroatLabs repo in this script." >&2
  exit 1
fi
GH_USER="$(gh api user --jq .login)"

graph_err="$(mktemp)"
if ! az rest --method GET --url 'https://graph.microsoft.com/v1.0/applications?$select=id&$top=1' --output none 2>"$graph_err"; then
  note "Azure login cannot create Entra app registrations. Microsoft Graph denied the request. An Application Administrator has to run this script."
  sed -n '1,20p' "$graph_err" >&2
fi
rm -f "$graph_err"

check_row() {
  local repo="$1" app="$2" rg="$3" scope admin
  if ! scope="$(az group show --name "$rg" --query id --output tsv 2>/dev/null)"; then
    note "Resource group ${rg} does not exist in subscription ${SUBSCRIPTION}."
  elif ! az role assignment list --scope "$scope" --fill-principal-name false --query "[0].id" --output tsv >/dev/null 2>&1; then
    note "This Azure login cannot read role assignments on ${rg}. It needs Owner or Role Based Access Control Administrator there."
  fi
  admin="$(gh api "repos/${ORG}/${repo}" --jq '.permissions.admin')"
  if [[ "$admin" != "true" ]]; then
    note "GitHub user ${GH_USER} is not an admin of ${ORG}/${repo}. Actions secrets require admin, and push access is not enough."
  fi
}
each_row check_row

if [[ "$failures" -ne 0 ]]; then
  echo "No apps, role assignments, or GitHub secrets were changed." >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

assign_contributor() {
  local sp_id="$1" scope="$2" rg="$3" err attempt
  err="$tmpdir/role.err"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if az role assignment create \
      --role Contributor \
      --assignee-object-id "$sp_id" \
      --assignee-principal-type ServicePrincipal \
      --scope "$scope" \
      --output none 2>"$err"; then
      return 0
    fi
    if grep -q 'RoleAssignmentExists' "$err"; then
      return 0
    fi
    if grep -q 'AuthorizationFailed' "$err"; then
      cat "$err" >&2
      echo "This login cannot assign Contributor on ${rg}." >&2
      return 1
    fi
    if ! grep -Eq 'PrincipalNotFound|does not exist in the directory' "$err"; then
      cat "$err" >&2
      return 1
    fi
    sleep 10
  done
  cat "$err" >&2
  echo "Entra has not published the service principal for ${rg} yet." >&2
  return 1
}

configure_row() {
  local repo="$1" app="$2" rg="$3"
  local subject scope app_ids app_id sp_id count assigned existing_subject existing_name
  subject="repo:${ORG}/${repo}:ref:refs/heads/${BRANCH}"
  scope="$(az group show --name "$rg" --query id --output tsv)"
  echo "Configuring ${ORG}/${repo}"

  app_ids="$(az ad app list --display-name "$app" --query "[?displayName=='${app}'].appId" --output tsv)"
  count="$(printf '%s\n' "$app_ids" | sed '/^$/d' | wc -l | tr -d ' ')"
  if [[ "$count" -gt 1 ]]; then
    echo "More than one Entra app is named ${app}. Stop and delete the extra before re-running." >&2
    exit 1
  fi
  if [[ "$count" -eq 0 ]]; then
    app_id="$(az ad app create --display-name "$app" --sign-in-audience AzureADMyOrg --query appId --output tsv)"
  else
    app_id="$app_ids"
  fi

  sp_id="$(az ad sp show --id "$app_id" --query id --output tsv 2>/dev/null || true)"
  if [[ -z "$sp_id" ]]; then
    sp_id="$(az ad sp create --id "$app_id" --query id --output tsv)"
  fi

  existing_subject="$(az ad app federated-credential list --id "$app_id" --query "[?subject=='${subject}'].name" --output tsv)"
  if [[ -z "$existing_subject" ]]; then
    existing_name="$(az ad app federated-credential list --id "$app_id" --query "[?name=='github-actions-main'].subject" --output tsv)"
    if [[ -n "$existing_name" ]]; then
      echo "App ${app} already has federated credential github-actions-main for ${existing_name}, not ${subject}." >&2
      exit 1
    fi
    cat > "$tmpdir/credential.json" <<EOF
{
  "name": "github-actions-main",
  "issuer": "${ISSUER}",
  "subject": "${subject}",
  "audiences": ["${AUDIENCE}"]
}
EOF
    az ad app federated-credential create --id "$app_id" --parameters "$tmpdir/credential.json" --output none
  fi

  assigned="$(az role assignment list \
    --assignee-object-id "$sp_id" \
    --scope "$scope" \
    --role Contributor \
    --fill-principal-name false \
    --query "length([?scope=='${scope}'])" \
    --output tsv)"
  if [[ "${assigned:-0}" -eq 0 ]]; then
    assign_contributor "$sp_id" "$scope" "$rg"
  fi

  printf '%s' "$app_id" | gh secret set AZURE_CLIENT_ID --repo "${ORG}/${repo}"
  printf '%s' "$TENANT_ID" | gh secret set AZURE_TENANT_ID --repo "${ORG}/${repo}"
  printf '%s' "$SUBSCRIPTION" | gh secret set AZURE_SUBSCRIPTION_ID --repo "${ORG}/${repo}"
  echo "  ${app}  ${app_id}  ${rg}"
}
each_row configure_row
