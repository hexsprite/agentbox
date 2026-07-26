#!/usr/bin/env bash
# AgentBox Sprites base installer.
#
# Unlike every other provider, this does NOT run once at `prepare` time to bake
# a reusable image — Sprites has no create-from-image and no fork-from-template
# yet (Fly has it working internally; no public endpoint as of 2026-07). So it
# runs on EVERY `agentbox create`, over `backend.exec`, against a freshly
# created sprite. See docs/sprites-backlog.md.
#
# That constraint is survivable only because Fly's base is already an agent
# image: Ubuntu 26.04 with Node 24, bun, deno, go, java, ruby, elixir, git,
# tmux, rsync, jq, gh, python3 — plus `claude` and `codex` pre-installed under
# the platform's own `sprite` user. Measured on a live sprite (2026-07-26) the
# whole run below lands at roughly two minutes, not the seven-to-ten a
# from-scratch Ubuntu bake costs on hetzner/digitalocean.
#
# Required inputs (uploaded by backend.provision before this runs):
#   /tmp/agentbox-ctl                   -- prebuilt @agentbox/ctl bundle (cjs)
#   /tmp/agentbox-vnc-start             -- VNC startup helper
#   /tmp/agentbox-dockerd-start         -- DinD startup helper
#   /tmp/agentbox-checkpoint-cleanup    -- pre-snapshot cleanup helper
#   /tmp/agentbox-open                  -- in-box xdg-open shim
#   /tmp/agentbox-gh-shim               -- in-box `gh` shim (routes to host gh via relay)
#   /tmp/agentbox-git-shim              -- in-box `git` shim (routes push/pull/fetch/clone via relay)
#   /tmp/agentbox-ntn-shim              -- in-box `ntn`/`notion` shim
#   /tmp/agentbox-linear-shim           -- in-box `linear` shim
#   /tmp/agentbox-custom-CLAUDE.md      -- /etc/claude-code/CLAUDE.md content
#   /tmp/agentbox-managed-settings.json -- /etc/claude-code/managed-settings.json
#   /tmp/agentbox-codex-hooks.json      -- /usr/local/share/agentbox/codex-hooks.json
#   /tmp/agentbox-setup-skill.md        -- /usr/local/share/agentbox/setup-guide.md
#
# Optional inputs (environment):
#   AGENTBOX_CLAUDE_INSTALL=native|npm  -- how to install Claude Code when the
#                                          base image doesn't already carry it
#   AGENTBOX_SPRITES_VNC=1              -- also install the VNC/Chromium stack
#                                          (~45s). Off by default: unlike a
#                                          baked image, every second here is
#                                          paid on every create.
#
# Output: noisy progress to stdout (the host streams it into
# ~/.agentbox/logs/create.log via backend.exec's onLog). Each major step prints
# `>>> BEGIN <step>` and `<<< END <step>` so a tail-watcher can spot a hang.

set -euo pipefail

step() { printf '\n>>> BEGIN %s\n' "$1"; }
done_() { printf '<<< END %s\n' "$1"; }

# Retry a command with exponential backoff. Usage: retry_backoff <max> cmd...
# Waits 60s before attempt 2, 240s before attempt 3 (~5 min total budget). Used
# for the Claude native installer, whose CDN (claude.ai / downloads.claude.ai,
# behind Cloudflare) intermittently 403s cloud-datacenter egress IPs under load.
retry_backoff() {
  local max=$1; shift
  local attempt=1
  local -a waits=(60 240)
  while true; do
    if "$@"; then return 0; fi
    if [ "$attempt" -ge "$max" ]; then return 1; fi
    local w=${waits[$((attempt-1))]:-240}
    echo "retry_backoff: attempt ${attempt}/${max} failed — backing off ${w}s" >&2
    sleep "$w"
    attempt=$((attempt+1))
  done
}

if [ "$(id -u)" -ne 0 ]; then
  echo "install-sprite-base.sh: must run as root (got uid $(id -u))" >&2
  exit 64
fi

export DEBIAN_FRONTEND=noninteractive

# The platform's own user, whose home carries the pre-installed agents. Not a
# guess: Fly creates it at UID 1001 and `sprite exec` / `sprite console` run as
# it. Overridable in case that changes.
SPRITE_USER="${AGENTBOX_SPRITE_USER:-sprite}"
SPRITE_HOME="$(getent passwd "$SPRITE_USER" | cut -d: -f6 || true)"
[ -n "$SPRITE_HOME" ] || SPRITE_HOME="/home/${SPRITE_USER}"

step "locate the platform toolchain"
# Fly puts node/npm/bun/go/… in a symlink farm at /.sprite/bin, and puts that
# directory on the `sprite` user's PATH from its own shell profile — NOT in
# /etc/environment. So root (this script) and the `vscode` user we're about to
# create both start with no node and no npm, and every npm step below dies with
# `npm: command not found`. Prepend it for the rest of this script, and bake it
# into /etc/profile.d/agentbox.sh further down so login shells get it too.
SPRITE_BIN="${AGENTBOX_SPRITE_BIN:-/.sprite/bin}"
if [ -d "$SPRITE_BIN" ]; then
  export PATH="${SPRITE_BIN}:${PATH}"
  echo "  toolchain: ${SPRITE_BIN} (node $(node --version 2>/dev/null || echo MISSING), npm $(npm --version 2>/dev/null || echo MISSING))"
else
  echo "  toolchain: ${SPRITE_BIN} not present — relying on the inherited PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "install-sprite-base.sh: no node on PATH after adding ${SPRITE_BIN} — cannot continue" >&2
  exit 72
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "install-sprite-base.sh: no npm on PATH after adding ${SPRITE_BIN} — cannot continue" >&2
  exit 72
fi
done_ "locate the platform toolchain"

step "vscode user (UID 1000) + sudoers"
# AgentBox standardizes on `vscode` at UID 1000 across every provider — the
# cloud scaffold hardcodes /home/vscode (credential pivots, the .claude.json
# overlay, the carry chain's `chown 1000:1000`). Fly's base has `ubuntu` on UID
# 1000 and nothing using it, so rename that rather than fight for the uid.
if ! id vscode >/dev/null 2>&1; then
  if existing="$(getent passwd 1000 | cut -d: -f1)"; then
    if [ -n "$existing" ] && [ "$existing" != "vscode" ]; then
      usermod -l vscode "$existing"
      usermod -d /home/vscode -m vscode || true
      groupmod -n vscode "$existing" 2>/dev/null || true
    fi
  fi
  if ! id vscode >/dev/null 2>&1; then
    useradd -m -u 1000 -s /bin/bash vscode
  fi
fi
install -d -m 0755 -o vscode -g vscode /home/vscode
echo 'vscode ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-agentbox-vscode
chmod 0440 /etc/sudoers.d/90-agentbox-vscode
done_ "vscode user (UID 1000) + sudoers"

step "agentbox base dirs + /workspace ownership"
mkdir -p /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox /etc/agentbox /etc/claude-code \
         /usr/local/share/agentbox
chmod 755 /workspace
chown vscode:vscode /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox
done_ "agentbox base dirs + /workspace ownership"

step "adopt the base image's pre-installed agents"
# Fly's base ships claude + codex (and gemini / cursor-agent, which AgentBox
# doesn't drive) under $SPRITE_HOME/.local — ~440MB of them. Copying that into
# /home/vscode would cost more wall-clock than everything else here combined,
# and re-downloading claude from its CDN is both slower and the one step that
# intermittently 403s datacenter egress. So we symlink instead.
#
# That needs $SPRITE_HOME traversable: Fly ships it 0750. This is not the
# privilege change it looks like — `vscode` has NOPASSWD sudo three lines up,
# so it can already read every byte under that directory. All the 0750 was
# buying is an extra `sudo`. Single-tenant box; the sprite itself is the
# isolation boundary.
chmod 0755 "$SPRITE_HOME" || true
install -d -o vscode -g vscode /home/vscode/.local /home/vscode/.local/bin

link_agent() {
  local name="$1" src="${SPRITE_HOME}/.local/bin/$1"
  if [ ! -e "$src" ]; then
    echo "  ${name}: not in base image"
    return 1
  fi
  ln -sfn "$src" "/home/vscode/.local/bin/${name}"
  chown -h vscode:vscode "/home/vscode/.local/bin/${name}"
  echo "  ${name}: linked -> $(readlink -f "$src" || echo "$src")"
  return 0
}

HAVE_CLAUDE=0
HAVE_CODEX=0
link_agent claude && HAVE_CLAUDE=1
link_agent codex && HAVE_CODEX=1
done_ "adopt the base image's pre-installed agents"

step "core tooling gaps (git-lfs, bubblewrap)"
# Everything else AgentBox needs — curl, git, tmux, jq, rsync, python3, gh,
# node 24, bun — is already in Fly's base. Only fill the holes.
apt-get update -qq
apt-get install -y --no-install-recommends git-lfs bubblewrap
done_ "core tooling gaps (git-lfs, bubblewrap)"

step "node setcap (port <1024 bind without root)"
# Fail loudly on a missing node rather than `readlink -f ""` silently resolving
# to the cwd and setcap no-oping behind a `|| true` — the toolchain probe above
# has already guaranteed node is on PATH, so anything wrong here is real.
NODE_BIN="$(readlink -f "$(command -v node)")"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "install-sprite-base.sh: could not resolve the node binary for setcap" >&2
  exit 72
fi
# The capability itself is best-effort: some kernels/filesystems refuse it, and
# a box without it still works for everything except binding :80 unprivileged.
setcap cap_net_bind_service=+ep "$NODE_BIN" || echo "  setcap failed on ${NODE_BIN} (continuing)"
done_ "node setcap (port <1024 bind without root)"

step "git system-wide safe.directory + LFS filter"
git config --system --add safe.directory '*'
# Register filter.lfs.* in /etc/gitconfig so an in-box checkout of an LFS repo
# smudges instead of writing pointer files. Cloud boxes have no bind-mounted
# ~/.gitconfig, so --system is the only place the filter lives. --skip-repo
# keeps install from touching a checkout.
git lfs install --system --skip-repo
done_ "git system-wide safe.directory + LFS filter"

step "docker for in-sprite DinD"
apt-get install -y --no-install-recommends docker.io iptables
mkdir -p /etc/docker
printf '%s\n' '{ "iptables": true }' > /etc/docker/daemon.json
usermod -aG docker vscode
# dockerd is launched by the cloud-provider scaffolding via
# `agentbox-dockerd-start` (the same script the docker provider uses), so we
# want the agentbox helper's storage-driver probe + flag composition, not
# Ubuntu's defaults. Sprites has no systemd, so there is no unit to disable —
# the package's init script simply never runs.
done_ "docker for in-sprite DinD"

step "agentbox-ctl install"
install -m 0755 /tmp/agentbox-ctl /usr/local/bin/agentbox-ctl
done_ "agentbox-ctl install"

step "baked helper scripts (vnc / dockerd / cleanup / xdg-open / gh + git + ntn + linear shims)"
install -m 0755 /tmp/agentbox-vnc-start          /usr/local/bin/agentbox-vnc-start
install -m 0755 /tmp/agentbox-dockerd-start      /usr/local/bin/agentbox-dockerd-start
install -m 0755 /tmp/agentbox-checkpoint-cleanup /usr/local/bin/agentbox-checkpoint-cleanup
install -m 0755 /tmp/agentbox-open               /usr/local/bin/agentbox-open
ln -sf /usr/local/bin/agentbox-open /usr/local/bin/xdg-open
# gh + git + ntn + linear shims — same files baked by Dockerfile.box for the
# docker provider. The shim wins on PATH (default /usr/local/bin precedes
# /usr/bin) so any agent call to `gh ...` / `git push|pull|fetch|clone` /
# `ntn ...` / `notion ...` / `linear ...` routes through the relay; the git
# shim execs /usr/bin/git for everything else, no overhead.
install -m 0755 /tmp/agentbox-gh-shim            /usr/local/bin/gh
install -m 0755 /tmp/agentbox-git-shim           /usr/local/bin/git
install -m 0755 /tmp/agentbox-ntn-shim           /usr/local/bin/ntn
ln -sf /usr/local/bin/ntn /usr/local/bin/notion
install -m 0755 /tmp/agentbox-linear-shim        /usr/local/bin/linear
done_ "baked helper scripts (vnc / dockerd / cleanup / xdg-open / gh + git + ntn + linear shims)"

step "baked config files (claude / codex / setup guide / tmux.conf)"
install -m 0644 /tmp/agentbox-custom-CLAUDE.md      /etc/claude-code/CLAUDE.md
install -m 0644 /tmp/agentbox-managed-settings.json /etc/claude-code/managed-settings.json
install -m 0644 /tmp/agentbox-codex-hooks.json      /usr/local/share/agentbox/codex-hooks.json
install -m 0644 /tmp/agentbox-setup-skill.md        /usr/local/share/agentbox/setup-guide.md

# tmux.conf — verbatim from Dockerfile.box.
cat > /etc/tmux.conf <<'TMUX'
set -g default-terminal "tmux-256color"
set -as terminal-overrides ",*:Tc"
set -as terminal-overrides ",*:RGB"
set -as terminal-features ",*:hyperlinks"
set -as terminal-features ",*:RGB"
set -g allow-passthrough on
set -g set-clipboard on
set -g extended-keys on
set -as terminal-features ",*:extkeys"
set -g mouse on
bind -T copy-mode    WheelUpPane   send -N2 -X scroll-up
bind -T copy-mode    WheelDownPane send -N2 -X scroll-down
bind -T copy-mode-vi WheelUpPane   send -N2 -X scroll-up
bind -T copy-mode-vi WheelDownPane send -N2 -X scroll-down
set -g history-limit 50000
set -g escape-time 0
TMUX
done_ "baked config files (claude / codex / setup guide / tmux.conf)"

step "credential pivot symlinks (vscode home)"
sudo -u vscode -H mkdir -p \
  /home/vscode/.claude \
  /home/vscode/.claude/skills/agentbox-setup \
  /home/vscode/.codex \
  /home/vscode/.cache/node/corepack \
  /home/vscode/.local/share/opencode \
  /home/vscode/.agentbox-creds/claude \
  /home/vscode/.agentbox-creds/codex \
  /home/vscode/.agentbox-creds/opencode
sudo -u vscode -H ln -sf /home/vscode/.agentbox-creds/claude/.credentials.json \
  /home/vscode/.claude/.credentials.json
sudo -u vscode -H ln -sf /home/vscode/.agentbox-creds/codex/auth.json \
  /home/vscode/.codex/auth.json
sudo -u vscode -H ln -sf /home/vscode/.agentbox-creds/opencode/auth.json \
  /home/vscode/.local/share/opencode/auth.json
sudo -u vscode -H ln -sf /home/vscode/.claude/_claude.json /home/vscode/.claude.json

# `/agentbox-setup` skill — the in-box-only first-run wizard the setup prompt
# references. Also reachable as a static file at
# /usr/local/share/agentbox/setup-guide.md (the wizard's fallback).
sudo -u vscode -H cp /usr/local/share/agentbox/setup-guide.md \
  /home/vscode/.claude/skills/agentbox-setup/SKILL.md
done_ "credential pivot symlinks (vscode home)"

step "login-shell shim (/etc/profile.d/agentbox.sh)"
# `$SPRITE_BIN` is expanded HERE (unquoted heredoc delimiter on the first
# block) because the location is discovered at install time; everything after
# is literal.
cat > /etc/profile.d/agentbox.sh <<PROFILE
# Auto-loaded by login shells; box.env is written at create time.
# Fly's toolchain (node, npm, bun, go, …) lives here and is only on the
# platform user's PATH by default — `vscode` needs it added explicitly.
case ":\$PATH:" in
  *:${SPRITE_BIN}:*) : ;;
  *) PATH=${SPRITE_BIN}:\$PATH ;;
esac
PROFILE
cat >> /etc/profile.d/agentbox.sh <<'PROFILE'
if [ -r /etc/agentbox/box.env ]; then
  set -a
  . /etc/agentbox/box.env
  set +a
fi
case ":$PATH:" in
  *:/home/vscode/.local/bin:*) : ;;
  *) PATH=/home/vscode/.local/bin:$PATH ;;
esac
export PATH
export COLORTERM=${COLORTERM:-truecolor}
export DISABLE_AUTOUPDATER=${DISABLE_AUTOUPDATER:-1}
export LANG=${LANG:-en_US.UTF-8}
export LC_ALL=${LC_ALL:-en_US.UTF-8}
export DISPLAY=${DISPLAY:-:1}
export AGENT_BROWSER_EXECUTABLE_PATH=${AGENT_BROWSER_EXECUTABLE_PATH:-/usr/local/bin/chromium}
export BROWSER=${BROWSER:-/usr/local/bin/agentbox-open}
PROFILE
chmod 0644 /etc/profile.d/agentbox.sh
done_ "login-shell shim (/etc/profile.d/agentbox.sh)"

step "corepack (pnpm + yarn shims)"
corepack enable pnpm yarn 2>/dev/null || npm install -g corepack@latest && corepack enable pnpm yarn
done_ "corepack (pnpm + yarn shims)"

step "opencode + portless (global npm)"
# npm 12 refuses lifecycle scripts on global installs unless allow-listed, and
# opencode-ai's postinstall is what fetches its platform binary.
npm install -g --allow-scripts=opencode-ai opencode-ai portless
# Node here is nvm-managed under /.sprite, whose bin dir is NOT on the default
# PATH (only the /.sprite/bin symlink farm is). Link what we install into
# /usr/local/bin so a login shell and a non-login `backend.exec` both find it.
NPM_BIN="$(npm prefix -g)/bin"
for tool in opencode portless; do
  if [ -x "${NPM_BIN}/${tool}" ] && [ ! -e "/usr/local/bin/${tool}" ]; then
    ln -sf "${NPM_BIN}/${tool}" "/usr/local/bin/${tool}"
  fi
done
done_ "opencode + portless (global npm)"

if [ "$HAVE_CLAUDE" -ne 1 ]; then
  # The base image didn't carry claude (Fly changed the image, or a custom
  # SPRITE_USER). Fall back to the same install the VPS providers use.
  if [ "${AGENTBOX_CLAUDE_INSTALL:-native}" = "npm" ]; then
    step "Claude Code (npm fallback: @anthropic-ai/claude-code)"
    npm install -g @anthropic-ai/claude-code
    install -d -o vscode -g vscode /home/vscode/.local/bin
    ln -sf "$(command -v claude)" /home/vscode/.local/bin/claude
    chown -h vscode:vscode /home/vscode/.local/bin/claude
    command -v claude >/dev/null || { echo "install-sprite-base.sh: npm claude install produced no claude on PATH" >&2; exit 71; }
    done_ "Claude Code (npm fallback: @anthropic-ai/claude-code)"
  else
    step "Claude Code (native installer fallback, run as vscode)"
    # Anthropic's CDN sits behind Cloudflare, which intermittently 403s
    # cloud-datacenter egress under load. Keep pipefail and fold the PATH check
    # in so a "succeeded but absent" result also retries.
    if ! retry_backoff 3 sudo -u vscode -H bash -lc \
         'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s stable && command -v claude >/dev/null'; then
      echo "install-sprite-base.sh: Claude native installer failed after 3 attempts (Cloudflare 403?)" >&2
      exit 71
    fi
    done_ "Claude Code (native installer fallback, run as vscode)"
  fi
fi

if [ "$HAVE_CODEX" -ne 1 ]; then
  step "Codex CLI (npm fallback)"
  npm install -g @openai/codex
  done_ "Codex CLI (npm fallback)"
fi

if [ "${AGENTBOX_SPRITES_VNC:-0}" = "1" ]; then
  # ~45s measured. Opt-in because on Sprites this is paid per box, not once at
  # bake time — see the header. `agentbox create --vnc` sets the flag.
  step "VNC stack (TigerVNC + noVNC + websockify + autocutsel)"
  apt-get install -y --no-install-recommends \
    tigervnc-standalone-server tigervnc-common tigervnc-tools \
    novnc websockify \
    autocutsel xclip
  mkdir -p /home/vscode/.vnc
  chown -R vscode:vscode /home/vscode/.vnc
  done_ "VNC stack (TigerVNC + noVNC + websockify + autocutsel)"

  step "Chrome runtime libs"
  apt-get install -y --no-install-recommends \
    libnss3 libnss3-tools libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libdrm2 libpango-1.0-0 libcairo2 libasound2t64 \
    fonts-liberation xdg-utils
  done_ "Chrome runtime libs"

  step "allow unprivileged user namespaces (sysctl drop-in)"
  # Ubuntu 23.10+ enables an AppArmor knob that blocks unprivileged user
  # namespaces, which Chromium's sandbox needs. Without this, every in-box
  # `chromium` / `agent-browser` invocation dies with "No usable sandbox!".
  cat > /etc/sysctl.d/99-agentbox-userns.conf <<'SYSCTL'
# Written by AgentBox install-sprite-base.sh — Chromium needs unprivileged user
# namespaces for its sandbox; the sprite itself is the isolation boundary.
kernel.apparmor_restrict_unprivileged_userns = 0
kernel.unprivileged_userns_clone = 1
SYSCTL
  chmod 0644 /etc/sysctl.d/99-agentbox-userns.conf
  sysctl -p /etc/sysctl.d/99-agentbox-userns.conf >/dev/null 2>&1 || true
  done_ "allow unprivileged user namespaces (sysctl drop-in)"

  step "agent-browser + playwright + Chromium (as vscode)"
  npm install -g --allow-scripts=playwright agent-browser playwright
  for tool in agent-browser playwright; do
    if [ -x "$(npm prefix -g)/bin/${tool}" ] && [ ! -e "/usr/local/bin/${tool}" ]; then
      ln -sf "$(npm prefix -g)/bin/${tool}" "/usr/local/bin/${tool}"
    fi
  done
  # Run the download as vscode so the cache lands under
  # /home/vscode/.cache/ms-playwright. Resolve a stable symlink at
  # /usr/local/bin/chromium so AGENT_BROWSER_EXECUTABLE_PATH stays predictable
  # across Chromium revision bumps.
  sudo -u vscode -H bash -lc 'playwright install chromium'
  CHROME_BIN="$(sudo -u vscode -H bash -lc 'ls /home/vscode/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1')"
  if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
    echo "install-sprite-base.sh: could not resolve Playwright Chromium binary" >&2
    exit 70
  fi
  ln -sf "$CHROME_BIN" /usr/local/bin/chromium
  done_ "agent-browser + playwright + Chromium (as vscode)"
fi

step "trim /tmp/agentbox-*"
rm -f /tmp/agentbox-ctl /tmp/agentbox-vnc-start /tmp/agentbox-dockerd-start \
      /tmp/agentbox-checkpoint-cleanup /tmp/agentbox-open \
      /tmp/agentbox-gh-shim /tmp/agentbox-git-shim /tmp/agentbox-ntn-shim \
      /tmp/agentbox-linear-shim \
      /tmp/agentbox-custom-CLAUDE.md /tmp/agentbox-managed-settings.json \
      /tmp/agentbox-codex-hooks.json /tmp/agentbox-setup-skill.md
# Keep the installer itself for diagnostics.
mv /tmp/agentbox-install-sprite-base.sh /var/log/agentbox/install-sprite-base.sh 2>/dev/null || true
done_ "trim /tmp/agentbox-*"

printf '\n*** install-sprite-base.sh: complete — sprite ready.\n'
