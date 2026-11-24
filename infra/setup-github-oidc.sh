#!/usr/bin/env bash
# One Entra app per repo, trusted only for jobs in that repo's production
# environment (which GitHub restricts to v* tags). In the resource group it may
# run deployments ("<Repo> Deployment Operator") and has Contributor on that
# repo's own storage account, nothing else: the group holds other projects too.
# Re-running updates GitHub secrets and leaves existing apps, trusts, roles and
# environment protection in place; it never adds a second trust to an app.
#
# The storage account must exist first (`just deploy` creates it).
#
# Checks every prerequisite and exits before creating anything if one is missing.
#
#   ./infra/setup-github-oidc.sh
set -euo pipefail

SUBSCRIPTION="1e238434-310b-4bcd-ab1f-a9381d170243"
ORG="BluethroatLabs"
ISSUER="https://token.actions.githubusercontent.com"
AUDIENCE="api://AzureADTokenExchange"
ENVIRONMENT="production"
TAG_PATTERN="v*"
# BlueExif's storage lives in BlueMask's group. CI deploys with
# DEPLOY_FRONT_DOOR=false, so it needs no role on the shared Front Door group.
ROWS='BlueExif|github-blueexif|rg-bluemask-wehi-sandbox
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
    note "This Azure login cannot read role assignments on ${rg}. It needs Owner there (it creates a role definition and assigns roles)."
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

assign_role() {
  local role="$1" sp_id="$2" scope="$3" err attempt
  err="$tmpdir/role.err"
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if az role assignment create \
      --role "$role" \
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
      echo "This login cannot assign ${role} on ${scope}." >&2
      return 1
    fi
    # A new service principal or role definition takes a while to be visible.
    if ! grep -Eq 'PrincipalNotFound|does not exist in the directory|RoleDefinitionDoesNotExist' "$err"; then
      cat "$err" >&2
      return 1
    fi
    sleep 10
  done
  cat "$err" >&2
  echo "Azure has not published the service principal or the role ${role} yet." >&2
  return 1
}

ensure_role() {
  local role="$1" sp_id="$2" scope="$3" assigned
  role="${repo} Deployment Operator"
  if [[ -z "$(az role definition list --name "$role" --scope "$scope" --query "[0].name" --output tsv)" ]]; then
    cat > "$tmpdir/role.json" <<EOF
{
  "Name": "${role}",
  "Description": "Run resource group deployments for ${repo}.",
  "Actions": [
    "Microsoft.Resources/deployments/*",
    "Microsoft.Resources/subscriptions/resourceGroups/read"
  ],
  "AssignableScopes": ["${scope}"]
}
EOF
    az role definition create --role-definition "$tmpdir/role.json" --output none
  fi
  storage="$(az storage account list --resource-group "$rg" \
    --query "[?starts_with(name, 'st$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')')].id" --output tsv)"
  if [[ -z "$storage" || "$storage" == *$'\n'* ]]; then
    echo "Expected exactly one ${repo} storage account in ${rg} (just deploy creates it). Found: ${storage:-none}" >&2
    exit 1
  fi
  ensure_role "$role" "$sp_id" "$scope"
  ensure_role Contributor "$sp_id" "$storage"

  # Deployments to the environment are only accepted from tags matching
  # TAG_PATTERN. An existing environment keeps its reviewers and other rules.
  if ! gh api "repos/${ORG}/${repo}/environments/${ENVIRONMENT}" --silent 2>/dev/null; then
    gh api --method PUT "repos/${ORG}/${repo}/environments/${ENVIRONMENT}" \
      -F 'deployment_branch_policy[protected_branches]=false' \
      -F 'deployment_branch_policy[custom_branch_policies]=true' --silent
  fi
  if [[ -z "$(gh api "repos/${ORG}/${repo}/environments/${ENVIRONMENT}/deployment-branch-policies" \
    --jq ".branch_policies[] | select(.type == \"tag\" and .name == \"${TAG_PATTERN}\") | .name")" ]]; then
    gh api --method POST "repos/${ORG}/${repo}/environments/${ENVIRONMENT}/deployment-branch-policies" \
      -f name="$TAG_PATTERN" -f type=tag --silent
  fi

  printf '%s' "$app_id" | gh secret set AZURE_CLIENT_ID --repo "${ORG}/${repo}"
  printf '%s' "$TENANT_ID" | gh secret set AZURE_TENANT_ID --repo "${ORG}/${repo}"
  printf '%s' "$SUBSCRIPTION" | gh secret set AZURE_SUBSCRIPTION_ID --repo "${ORG}/${repo}"
  echo "  ${app}  ${app_id}  ${rg}"
}
each_row configure_row
