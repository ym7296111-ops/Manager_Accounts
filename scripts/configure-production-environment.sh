#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# configure-production-environment.sh
#
# Idempotent setup of the GitHub Environment used by the production migration
# workflow and read-only production telemetry. These workflows require the
# SUPABASE_PROJECT_REF variable and the SUPABASE_ACCESS_TOKEN and
# SUPABASE_DB_PASSWORD secrets.
#
# Usage
# -----
#   ./scripts/configure-production-environment.sh --check
#       Read-only. Reports the environment GitHub resolves, and which
#       secret/variable names exist. (Requires admin rights to list secrets.)
#
#   ./scripts/configure-production-environment.sh --apply --project-ref <ref> \
#       [--access-token <token>] [--db-password <password>]
#       Writes the required values. Any omitted secret is read interactively
#       (stdin is never echoed for secrets) or taken from the matching
#       SUPABASE_* environment variable.
#
#   ./scripts/configure-production-environment.sh --run
#       Dispatches a dry run of the migration workflow on main and prints the
#       URL of the run, so the result can be verified immediately.
#
# Values are never printed back: only names and a length/"set" marker.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_DEFAULT="ym7296111-ops/admin_system"
ENVIRONMENT="Production" # GitHub matches environment names case-insensitively

MODE="check"
REPO="$REPO_DEFAULT"
PROJECT_REF=""
ACCESS_TOKEN=""
DB_PASSWORD=""

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check" ;;
    --apply) MODE="apply" ;;
    --run) MODE="run" ;;
    --repo)
      REPO="${2:?--repo needs a value}"
      shift
      ;;
    --project-ref)
      PROJECT_REF="${2:?--project-ref needs a value}"
      shift
      ;;
    --access-token)
      ACCESS_TOKEN="${2:?--access-token needs a value}"
      shift
      ;;
    --db-password)
      DB_PASSWORD="${2:?--db-password needs a value}"
      shift
      ;;
    -h | --help) usage 0 ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage 1
      ;;
  esac
  shift
done

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

note() { printf '%s\n' "$*"; }
head2() { printf '\n== %s ==\n' "$*"; }

command -v gh > /dev/null || die "the GitHub CLI (gh) is required"
gh auth status > /dev/null 2>&1 || die "gh is not authenticated; run: gh auth login"

head2 "Repository"
gh repo view "$REPO" --json nameWithOwner,defaultBranchRef \
  --template '{{.nameWithOwner}} (default branch: {{.defaultBranchRef.name}}){{"\n"}}'

head2 "Environments declared on the repository"
gh api "repos/$REPO/environments" --jq '.environments[] | "  \(.name)"' ||
  die "cannot read environments (needs a token with admin:repo or repo scope)"

resolved="$(gh api "repos/$REPO/environments" --jq "[.environments[].name | select(ascii_downcase == \"$(printf '%s' "$ENVIRONMENT" | tr '[:upper:]' '[:lower:]')\")] | first // empty")"
[ -n "$resolved" ] || die "no environment matches \"$ENVIRONMENT\""
note "  -> jobs that ask for \"$ENVIRONMENT\" resolve to: \"$resolved\" (names are case-insensitive)"

# ---------------------------------------------------------------------------
# Presence report. Listing secrets/variables requires admin rights on the
# repository; without them the write steps below still work if the account can
# manage environments, so a 403 here is reported, not fatal.
# ---------------------------------------------------------------------------
head2 "Current contents of \"$resolved\""
report_names() {
  local kind="$1" jq_filter="$2"
  if out="$(gh api "repos/$REPO/environments/$resolved/$kind" --jq "$jq_filter" 2>&1)"; then
    if [ -n "$out" ]; then
      printf '%s\n' "$out" | sed 's/^/  /'
    else
      note "  ($kind: none)"
    fi
  else
    note "  ($kind: cannot list - $out)"
  fi
}
report_names secrets '.secrets[].name'
report_names variables '.variables[].name'

# ---------------------------------------------------------------------------
read_secret() {
  local label="$1" fallback_env="$2" value=""
  if [ -n "${!fallback_env:-}" ]; then
    printf '%s' "${!fallback_env}"
    return
  fi
  [ -t 0 ] || die "$fallback_env is not set and stdin is not a terminal"
  printf '%s: ' "$label" >&2
  IFS= read -r -s value
  printf '\n' >&2
  printf '%s' "$value"
}

validate_project_ref() {
  [[ "$1" =~ ^[a-z0-9]{20}$ ]] ||
    die "a Supabase project ref is exactly 20 lowercase alphanumeric characters"
}
# ---------------------------------------------------------------------------

if [ "$MODE" = "apply" ]; then
  head2 "Applying missing values to \"$resolved\""

  [ -n "$PROJECT_REF" ] || PROJECT_REF="$(read_secret 'Supabase project ref' SUPABASE_PROJECT_REF)"
  validate_project_ref "$PROJECT_REF"
  ACCESS_TOKEN="$(read_secret 'Supabase access token (Dashboard -> Account -> Tokens)' SUPABASE_ACCESS_TOKEN)"
  DB_PASSWORD="$(read_secret 'Database password (Settings -> Database)' SUPABASE_DB_PASSWORD)"

  gh variable set SUPABASE_PROJECT_REF --repo "$REPO" --env "$resolved" --body "$PROJECT_REF"
  note "  SUPABASE_PROJECT_REF  -> variable (${#PROJECT_REF} chars)"

  gh secret set SUPABASE_ACCESS_TOKEN --repo "$REPO" --env "$resolved" --body "$ACCESS_TOKEN"
  note "  SUPABASE_ACCESS_TOKEN -> secret"

  gh secret set SUPABASE_DB_PASSWORD --repo "$REPO" --env "$resolved" --body "$DB_PASSWORD"
  note "  SUPABASE_DB_PASSWORD  -> secret"


  head2 "Verify"
  report_names secrets '.secrets[].name'
  report_names variables '.variables[].name'
fi

if [ "$MODE" = "run" ]; then
  head2 "Dispatching a dry run of the migration workflow on main"
  gh workflow run supabase-migration.yml --repo "$REPO" --ref main \
    -f dry_run=true -f include_all=false -f mark_applied=''
  sleep 5
  gh run list --repo "$REPO" --workflow supabase-migration.yml --branch main --limit 1 \
    --json databaseId,url,status,conclusion \
    --template '{{range .}}{{.url}} ({{.status}} {{.conclusion}}){{"\n"}}{{end}}'
  note "  A dry run applies nothing; once it is green, dispatch again with dry_run=false."
fi

if [ "$MODE" = "check" ]; then
  head2 "Next step"
  note "  Re-run with --apply --project-ref <ref> to write the missing values."
fi
