#!/usr/bin/env bash
# The project folder is shared with the host (the computer running the
# container). Git hooks, and git settings that run commands, configured in it
# run on the host the next time you use git there. This script warns if any
# appear. It runs on every container start and can be run by hand, on the host
# too: `bash .devcontainer/check-host-safety.sh` (on Windows, from Git Bash or
# WSL).
set -uo pipefail

# .git is a file, not a folder, in worktrees and submodules; ask git.
git_dir="$(git rev-parse --git-dir 2>/dev/null)" || exit 0
common_dir="$(git rev-parse --git-common-dir 2>/dev/null)" || common_dir="$git_dir"

problems=0

# Settings in .git/config (and .git/config.worktree) that make git run a
# program. Keys are matched in the lowercase form `git config --list` prints.
risky_keys='^(core\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass|gitproxy)'
risky_keys+='|sequence\.editor|diff\.external|diff\..+\.(textconv|command)'
risky_keys+='|filter\..+\.(clean|smudge|process)|merge\..+\.driver'
risky_keys+='|credential\.(.+\.)?helper|gpg\.(.+\.)?program|pager\..+'
risky_keys+='|remote\..+\.(uploadpack|receivepack)|include\.path|includeif\..+)='

risky_config="$(
  {
    git config --local --list 2>/dev/null
    [ -f "$git_dir/config.worktree" ] && git config --file "$git_dir/config.worktree" --list 2>/dev/null
  } | grep -Ei "$risky_keys"
)"
# Aliases starting with "!" run shell commands.
risky_aliases="$(git config --local --get-regexp '^alias\.' 2>/dev/null | grep -E '^alias\.[^ ]+ !')"

if [ -n "$risky_config$risky_aliases" ]; then
  echo "WARNING: this repo's git config has settings that run programs"
  echo "         (git on the host will run them too):"
  printf '%s\n' "$risky_config" "$risky_aliases" | sed '/^$/d; s/^/         /'
  echo "         Review .git/config; remove one with: git config --local --unset <key>"
  problems=1
fi

active_hooks="$(find "$common_dir/hooks" -maxdepth 1 -type f ! -name '*.sample' 2>/dev/null)"
if [ -n "$active_hooks" ]; then
  echo "WARNING: active git hooks found (these run on the host too):"
  echo "$active_hooks" | sed 's/^/         /'
  problems=1
fi

if [ -d .beads/hooks ] && [ -n "$(ls -A .beads/hooks 2>/dev/null)" ]; then
  echo "NOTE: .beads/hooks/ has scripts; bd runs them on issue create/close."
  echo "      They are contained in the container but can edit project files:"
  ls -l .beads/hooks | sed 's/^/      /'
fi

[ "$problems" -eq 0 ] && echo "host-safety check: no git hooks or command-running git settings configured."
exit 0
