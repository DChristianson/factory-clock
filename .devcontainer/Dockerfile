# Image for agentic development on Factory Clock with beads (bd), git and Claude Code.
# See README.md in this folder for what each piece is for and why.

FROM mcr.microsoft.com/devcontainers/base:bookworm

ARG TARGETARCH

# ---- Base tools --------------------------------------------------------------
# Node comes from a feature in devcontainer.json. There is deliberately no sudo
# inside the running container, so installs belong in this file.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq ripgrep less procps \
 && rm -rf /var/lib/apt/lists/*

# ---- beads (bd) --------------------------------------------------------------
# Pinned release. The hashes are written here (not fetched from the release's
# own checksums.txt) and were checked against GitHub build attestations with:
#   gh attestation verify beads_<ver>_linux_<arch>.tar.gz --repo gastownhall/beads
# Built by .github/workflows/release.yml at refs/tags/v1.3.4 (commit 7ef2fd0).
# To upgrade: change BD_VERSION, re-run that check, update both hashes.
ARG BD_VERSION=1.3.4
ARG BD_SHA256_arm64=f4ee6eb3ec79bb2d7eb9d717c73efbcb6fa763cc70f726b4d055b72afdd68ad5
ARG BD_SHA256_amd64=175c26904bde3ff9168d2282ff6b56f17b17f60c22fa5acb3dacc9fb3465303a
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) sha="$BD_SHA256_arm64" ;; \
      amd64) sha="$BD_SHA256_amd64" ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    f="beads_${BD_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    curl -fsSL -o "/tmp/$f" "https://github.com/gastownhall/beads/releases/download/v${BD_VERSION}/$f"; \
    echo "$sha  /tmp/$f" | sha256sum -c -; \
    tar -xzf "/tmp/$f" -C /tmp bd; \
    install -m 0755 /tmp/bd /usr/local/bin/bd; \
    rm -f "/tmp/$f" /tmp/bd

# ---- Lock down the dev user --------------------------------------------------
# The base image gives "vscode" passwordless sudo. Remove it so nothing running
# as that user (the agent, bd, bd's repo hooks) can become root.
RUN rm -f /etc/sudoers.d/vscode \
 && mkdir -p /home/vscode/.claude \
 && chown -R vscode:vscode /home/vscode/.claude

USER vscode

# ---- Claude Code -------------------------------------------------------------
# Native installer; installs to ~/.local/bin for the vscode user.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/vscode/.local/bin:${PATH}"
