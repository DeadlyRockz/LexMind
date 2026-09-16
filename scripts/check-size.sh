#!/usr/bin/env bash
#
# Repo size guard.
#
# "The repository size must be less than 10 MB" is a hard submission rule, and a repository that
# breaches it is not re-scored — it is not evaluated at all. So this is a check that fails the
# build, not a note in a README that someone remembers to read.
#
# Two numbers are measured, because "repo size" is ambiguous and only the larger one matters:
#
#   1. the packed object store (.git/objects) — what a clone actually transfers, history included;
#   2. the tracked working tree at HEAD — what a source download (`git archive`) contains.
#
# The most common way to breach the limit is a single file: a real lease PDF, a print-resolution
# slide deck, a committed lockfile-adjacent binary. The top offenders are therefore always
# printed, not only on failure, so the number is visible before it becomes a problem.
#
# Usage: bash scripts/check-size.sh [limit-in-MB]   (default 10)

set -euo pipefail

limit_mb="${1:-10}"
limit_bytes=$(( limit_mb * 1024 * 1024 ))
# Warn well before the wall, so growth is caught in the PR that causes it.
warn_bytes=$(( limit_bytes * 70 / 100 ))

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "check-size: not a git repository — nothing to measure." >&2
  exit 1
fi
cd "$repo_root"

# Portable byte formatting. `numfmt` is coreutils-only and absent from stock macOS.
human() {
  awk -v b="$1" 'BEGIN {
    split("B KB MB GB", unit, " ")
    i = 1
    while (b >= 1024 && i < 4) { b /= 1024; i++ }
    printf (i == 1 ? "%d %s" : "%.2f %s"), b, unit[i]
  }'
}

# ── 1. Packed object store ─────────────────────────────────────────────────────────────────────
# `git count-objects -v` reports `size` (loose) and `size-pack` (packed) in KiB. Loose objects are
# counted too: before the first `git gc` everything is loose, and it still has to be cloned.
objects_kib=$(git count-objects -v | awk '/^size(-pack)?:/ { total += $2 } END { print total + 0 }')
objects_bytes=$(( objects_kib * 1024 ))

# ── 2. Tracked working tree at HEAD ────────────────────────────────────────────────────────────
if git rev-parse --verify --quiet HEAD >/dev/null; then
  worktree_bytes=$(git archive --format=tar HEAD | wc -c | tr -d '[:space:]')
  list_files() { git ls-tree -r -l HEAD; }
else
  # Pre-first-commit: measure what is staged, so the guard is usable before the repo has history.
  echo "check-size: no commit yet — measuring the index instead of HEAD."
  worktree_bytes=0
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue
    worktree_bytes=$(( worktree_bytes + $(wc -c < "$f" | tr -d '[:space:]') ))
  done < <(git ls-files -z)
  list_files() { :; }
fi

largest=$(( objects_bytes > worktree_bytes ? objects_bytes : worktree_bytes ))

echo "Repo size guard (limit ${limit_mb} MB)"
echo "  git object store   $(human "$objects_bytes")"
echo "  tracked tree       $(human "$worktree_bytes")"
echo "  measured against   $(human "$largest")"

echo "  largest tracked files:"
if list_files >/dev/null 2>&1 && [ -n "$(list_files)" ]; then
  list_files \
    | awk '$4 != "-" { printf "%s\t%s\n", $4, $5 }' \
    | sort -rn \
    | head -5 \
    | while IFS=$'\t' read -r size path; do
        printf '    %10s  %s\n' "$(human "$size")" "$path"
      done
else
  echo "    (none yet)"
fi

if [ "$largest" -ge "$limit_bytes" ]; then
  echo
  echo "FAIL: repository is $(human "$largest"), at or over the ${limit_mb} MB submission limit." >&2
  echo "      Remove large files from history (git filter-repo), not just from the working tree:" >&2
  echo "      deleting a blob in a new commit leaves it in the pack and does not shrink a clone." >&2
  exit 1
fi

if [ "$largest" -ge "$warn_bytes" ]; then
  echo
  echo "WARN: repository is $(human "$largest"), over 70% of the ${limit_mb} MB limit." >&2
fi

echo
echo "OK: $(human "$largest") is under the ${limit_mb} MB limit."
