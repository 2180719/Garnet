#!/bin/sh
# Ruby installer: clones (or updates) Ruby, installs its two dependencies and
# puts a `ruby` command in ~/.local/bin. No sudo, no shell-profile edits, and
# safe to run again: a second run updates in place.
#
#   curl -fsSL https://raw.githubusercontent.com/2180719/Ruby/main/install.sh | sh
#   sh install.sh --help
#
# Everything lives in two places you can delete: the install directory and the
# shim. Your data (config, memory, secrets) stays in ~/.ruby.

set -eu

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --dir <path>       Where to put Ruby's code
                     (default: $XDG_DATA_HOME/ruby or ~/.local/share/ruby; env RUBY_INSTALL_DIR)
  --bin-dir <path>   Where to put the `ruby` command (default: ~/.local/bin; env RUBY_BIN_DIR)
  --name <name>      Command name (default: ruby; env RUBY_BIN_NAME). Use another name if
                     `ruby` (the programming language) should keep its name.
  --ref <branch>     Branch to install (default: main; env RUBY_REF)
  --repo <url>       Git repository (default: https://github.com/2180719/Ruby; env RUBY_REPO)
  --no-setup         Do not start `ruby setup` afterwards
  -h, --help         Show this help
EOF
}

# Wrapped in a function so a partial download never runs half a script.
main() {
  repo=${RUBY_REPO:-https://github.com/2180719/Ruby}
  ref=${RUBY_REF:-main}
  dir=${RUBY_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/ruby}
  bin_dir=${RUBY_BIN_DIR:-$HOME/.local/bin}
  name=${RUBY_BIN_NAME:-ruby}
  run_setup=yes

  while [ $# -gt 0 ]; do
    case $1 in
      --dir) dir=${2:?--dir needs a path}; shift ;;
      --bin-dir) bin_dir=${2:?--bin-dir needs a path}; shift ;;
      --name) name=${2:?--name needs a name}; shift ;;
      --ref) ref=${2:?--ref needs a branch}; shift ;;
      --repo) repo=${2:?--repo needs a URL}; shift ;;
      --no-setup) run_setup=no ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "Unknown option: $1" ;;
    esac
    shift
  done
  case $name in
    ''|*/*|*' '*) die "--name must be a plain command name." ;;
  esac

  setup_colors
  printf '\n%s◆ RUBY%s %s/ INSTALL%s\n\n' "$accent" "$reset" "$muted" "$reset"

  if [ "$(id -u)" = 0 ]; then
    warn "You are root. Ruby is meant to run as a regular user (its sandbox and service assume it). Continuing."
  fi

  # 1. Requirements
  step "Checking requirements"
  need git "Install git with your package manager (for example: apt install git, brew install git)."
  check_node
  need npm "npm comes with Node.js; reinstall Node.js from https://nodejs.org."
  ok "git, Node.js $node_version and npm"

  # 2. Code
  if [ -d "$dir/.git" ]; then
    step "Updating $dir"
    update_repo
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then
    die "$dir exists and is not a Ruby checkout. Move it away, or pick another place with --dir."
  else
    step "Downloading Ruby into $dir"
    mkdir -p "$(dirname "$dir")"
    git clone --quiet --branch "$ref" "$repo" "$dir" || die "git clone $repo failed."
    ok "Cloned $repo ($ref) at $(git -C "$dir" rev-parse --short HEAD)"
  fi
  [ -f "$dir/src/cli/bin.ts" ] || die "$dir does not look like Ruby (no src/cli/bin.ts)."

  # 3. Dependencies (runtime only: zod and the Anthropic SDK)
  step "Installing dependencies"
  (cd "$dir" && npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error >/dev/null) || die "npm ci failed in $dir; see the output above."
  ok "Dependencies installed"

  # 4. The command
  step "Adding the \`$name\` command"
  write_shim
  ok "$bin_dir/$name → $dir/src/cli/bin.ts"
  check_path

  # 5. Done
  home=${RUBY_HOME:-$HOME/.ruby}
  printf '\n%s◆ Ruby is installed.%s\n' "$accent" "$reset"
  if [ -f "$home/config.json" ]; then
    printf '  Your setup in %s is unchanged. Check it with: %s doctor\n' "$home" "$name"
    if [ -f "$HOME/.config/systemd/user/ruby.service" ] || [ -f "$HOME/Library/LaunchAgents/dev.ruby.agent.plist" ]; then
      printf '  The background service still runs the old code until restarted: %s setup (or systemctl --user restart ruby)\n' "$name"
    fi
  elif [ "$run_setup" = yes ] && [ -t 1 ] && (: </dev/tty) 2>/dev/null; then
    printf '  Starting %s setup (Ctrl+C to do it later)…\n' "$name"
    "$bin_dir/$name" setup </dev/tty || printf '  Run %s setup whenever you are ready.\n' "$name"
  else
    printf '  Next: %s setup\n' "$name"
  fi
  printf '%s  Uninstall: rm -rf %s %s/%s (your data in %s is separate).%s\n\n' "$muted" "$dir" "$bin_dir" "$name" "$home" "$reset"
}

setup_colors() {
  if [ -t 1 ] && [ -z "${NO_COLOR+x}" ] && [ "${TERM:-}" != dumb ]; then
    accent=$(printf '\033[1;38;2;255;102;128m'); muted=$(printf '\033[38;2;163;166;173m')
    green=$(printf '\033[32m'); yellow=$(printf '\033[33m'); red=$(printf '\033[31m'); reset=$(printf '\033[0m')
  else
    accent=''; muted=''; green=''; yellow=''; red=''; reset=''
  fi
}

step() { printf '%s==>%s %s\n' "$accent" "$reset" "$1"; }
ok() { printf '  %s✓%s %s\n' "$green" "$reset" "$1"; }
warn() { printf '  %s!%s %s\n' "$yellow" "$reset" "$1" >&2; }
die() { printf '  %s✗%s %s\n' "${red:-}" "${reset:-}" "$1" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed. $2"
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    node_help "Node.js is not installed."
  fi
  node_version=$(node -p 'process.versions.node' 2>/dev/null || echo 0.0.0)
  major=${node_version%%.*}
  rest=${node_version#*.}
  minor=${rest%%.*}
  if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 18 ]; }; then
    node_help "Node.js $node_version is too old."
  fi
  node --disable-warning=ExperimentalWarning -e "require('node:sqlite')" >/dev/null 2>&1 ||
    die "This Node.js build has no node:sqlite. Use an official Node.js 22.18+ build from https://nodejs.org."
}

node_help() {
  printf '  %s✗%s %s Ruby needs Node.js 22.18 or newer.\n' "$red" "$reset" "$1" >&2
  cat >&2 <<'EOF'

    Install it without sudo using a version manager, then run this installer again:
      curl -fsSL https://fnm.vercel.app/install | bash    # then: fnm install 22
    or with nvm:  nvm install 22
    or download it from https://nodejs.org/en/download  (macOS: brew install node@22)

EOF
  exit 1
}

update_repo() {
  if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
    die "$dir has local changes; leaving it alone. Commit or stash them (or use a separate --dir), then run this again."
  fi
  origin=$(git -C "$dir" remote get-url origin 2>/dev/null || echo '')
  if [ "$origin" != "$repo" ]; then
    warn "$dir tracks $origin, not $repo. Updating from $origin."
  fi
  before=$(git -C "$dir" rev-parse --short HEAD)
  git -C "$dir" fetch --quiet origin "$ref" || die "git fetch failed for $ref."
  git -C "$dir" merge --ff-only --quiet FETCH_HEAD 2>/dev/null ||
    die "$dir has diverged from $ref (local commits?). Leaving it alone; update it by hand with git."
  after=$(git -C "$dir" rev-parse --short HEAD)
  if [ "$before" = "$after" ]; then ok "Already up to date ($after)"; else ok "Updated $before → $after"; fi
}

# Single-quotes a value for sh.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

write_shim() {
  shim="$bin_dir/$name"
  marker='# ruby-agent shim'
  if [ -e "$shim" ] && ! grep -q "$marker" "$shim" 2>/dev/null; then
    die "$shim already exists and is not Ruby's (maybe the Ruby language). Pick another command name with --name, e.g. --name rubyagent."
  fi
  mkdir -p "$bin_dir"
  node_path=$(command -v node)
  tmp="$shim.tmp.$$"
  {
    printf '#!/bin/sh\n'
    printf '%s, written by install.sh. Safe to delete; re-run install.sh to recreate.\n' "$marker"
    printf '# Uses the Node.js found at install time, or node on PATH if that is gone. Override with RUBY_NODE.\n'
    printf 'node=%s\n' "$(quote "$node_path")"
    printf '[ -x "$node" ] || node=node\n'
    printf 'exec "${RUBY_NODE:-$node}" --disable-warning=ExperimentalWarning %s "$@"\n' "$(quote "$dir/src/cli/bin.ts")"
  } >"$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$shim"
}

check_path() {
  case ":$PATH:" in
    *":$bin_dir:"*)
      found=$(command -v "$name" 2>/dev/null || echo '')
      if [ -n "$found" ] && [ "$found" != "$bin_dir/$name" ]; then
        warn "\`$name\` currently runs $found, which comes earlier in PATH (perhaps the Ruby language). Use $bin_dir/$name, move $bin_dir earlier in PATH, or reinstall with --name rubyagent."
      fi
      ;;
    *)
      shell_rc="~/.profile"
      case ${SHELL:-} in
        */zsh) shell_rc="~/.zshrc" ;;
        */bash) shell_rc="~/.bashrc" ;;
      esac
      warn "$bin_dir is not on your PATH. Add this line to $shell_rc, then open a new terminal:"
      case ${SHELL:-} in
        */fish) printf '      fish_add_path %s\n' "$bin_dir" >&2 ;;
        *) printf '      export PATH="%s:$PATH"\n' "$bin_dir" >&2 ;;
      esac
      found=$(command -v "$name" 2>/dev/null || echo '')
      if [ -n "$found" ]; then
        warn "After that, \`$name\` runs Ruby the agent instead of $found (perhaps the Ruby language). To keep that one as \`$name\`, reinstall with --name rubyagent."
      fi
      ;;
  esac
}

main "$@"
