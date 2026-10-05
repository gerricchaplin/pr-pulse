#!/usr/bin/env bash
# Open a throwaway draft PR that puts PR Pulse into one scenario, or clean them all up.
# Works through the GitHub API only, so your local checkout is never touched.
set -euo pipefail

usage() {
  cat <<'EOF'
usage: scripts/demo.sh <scenario>

  green   every check passes
  fail    the build check fails with a compile error (try "Fix with Claude")
  slow    a two-minute check, to watch the pane go from running to green
  flaky   fails first time, passes on re-run (gh run rerun --failed)
  skip    an optional check is skipped
  title   the required pr-title check fails (non-conventional title)
  clean   close every demo PR and delete its branch
EOF
}

scenario=${1:-}
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)

ensure_labels() {
  for name in fail slow flaky skip; do
    gh label create "demo:$name" --repo "$repo" --color 6000F0 \
      --description "PR Pulse demo: $name" --force >/dev/null
  done
}

case "$scenario" in
  green | fail | slow | flaky | skip | title) ;;
  clean)
    gh pr list --repo "$repo" --state open --search "head:demo/" --json number,headRefName \
      -q '.[] | "\(.number) \(.headRefName)"' |
      while read -r number branch; do
        gh pr close "$number" --repo "$repo" --delete-branch --comment "Demo finished." >/dev/null
        echo "closed #$number ($branch)"
      done
    exit 0
    ;;
  *)
    usage
    exit 1
    ;;
esac

ensure_labels
base=$(gh api "repos/$repo/git/ref/heads/main" -q .object.sha)
tree=$(gh api "repos/$repo/git/commits/$base" -q .tree.sha)
branch="demo/$scenario-$(date +%Y%m%d-%H%M%S)"

# an empty commit on top of main gives the PR something to show without changing any file
commit=$(gh api "repos/$repo/git/commits" -f message="chore: demo $scenario" -f tree="$tree" -f "parents[]=$base" -q .sha)
gh api "repos/$repo/git/refs" -f ref="refs/heads/$branch" -f sha="$commit" >/dev/null

title="chore: demo $scenario scenario"
labels=()
case "$scenario" in
  title) title="demo scenario with a non-conventional title" ;;
  fail | slow | flaky | skip) labels=(--label "demo:$scenario") ;;
esac

gh pr create --repo "$repo" --draft --base main --head "$branch" --title "$title" \
  --body "Throwaway PR for demoing [PR Pulse](https://github.com/$repo). Close with \`scripts/demo.sh clean\`." \
  ${labels[@]+"${labels[@]}"}
