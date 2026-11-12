# factory-clock dev container

## What a `.devcontainer` folder is

A `.devcontainer/` folder describes a Linux computer, in the form of a Docker
container, that your editor runs your project *inside*. When VS Code (with the
**Dev Containers** extension) opens a folder that contains one, it offers
**"Reopen in Container"**. It then:

1. **Builds an image** from `Dockerfile`: the OS, tools and versions this
   project needs.
2. **Starts a container** from that image with the options in
   `devcontainer.json`, and **mounts your project folder into it** at
   `/workspaces/factory-clock`. It's the same files, not a copy: edits on
   either side show up on the other.
3. **Runs setup hooks** (`postCreateCommand` once, `postStartCommand` on every
   start).
4. **Moves VS Code's backend into the container.** The window still runs on
   your Mac, but the terminal, extensions, language servers and Claude Code
   all run inside the container.

This gives you two things:

- **Reproducibility.** Anyone (or any future you) gets the same toolchain by
  opening the folder. Nothing is installed on your Mac.
- **Containment.** Code running in the container can only reach your
  project folder and the network. It can't reach the rest of your Mac's
  files, keychain, SSH keys or `~/.claude`.

`devcontainer.json` is an open spec (containers.dev). GitHub Codespaces,
JetBrains and the `devcontainer` CLI read it too.

## What's in this one

| File | Job |
|---|---|
| `Dockerfile` | Debian + git, curl, jq, ripgrep; **bd** pinned to a verified release; **Claude Code**; removes `sudo` |
| `devcontainer.json` | Node 24 and the GitHub CLI (as features), security options, Claude login volume, env vars, setup hooks, VS Code extension |
| `post-create.sh` | Runs once at creation: prints tool versions, turns bd metrics off |
| `init-project.sh` | Run once by hand: `git init` + `bd init --skip-hooks` (already done for this repo) |
| `check-host-safety.sh` | Runs on every start: warns if git hooks have been configured (see below) |

## First use

1. Install Docker Desktop and the VS Code extension **Dev Containers**
   (`ms-vscode-remote.remote-containers`).
2. Open your factory-clock checkout in VS Code, then **Reopen in Container**.
   The first build takes a few minutes.
3. In the container's terminal:
   ```bash
   claude        # log in once; the login is kept in a Docker volume
   npm ci
   bd ready      # the beads queue
   ```

## Building and testing

```bash
npm run build    # type-check, bundle, and assemble the page in site/
npm test         # the unit tests
```

The page is static files. `site/` is in the shared folder, so open
`site/index.html` in a browser on your Mac.

## Beads

Issues live in a Dolt database in `.beads/embeddeddolt/`, which git ignores.
Only `.beads/config.yaml`, `metadata.json`, `README.md` and `.gitignore` are
committed. `bd dolt push` and `bd dolt pull` sync the issues through
`refs/dolt/data` on the GitHub remote, apart from the code's branches. That
needs push access to the repo (see "Pushing to GitHub").

The database was created with `bd init --skip-hooks` (what `init-project.sh`
runs). In a fresh clone, run `bd dolt pull` to fetch the issues, then:
`bd create "Build X" -p 1`, `bd ready`, and have Claude work through the
queue.

## Safety model

**Contained:**
- Claude Code, `bd`, and any scripts in `.beads/hooks/` (which `bd` runs
  automatically on issue create/close) all run as an unprivileged user with
  no `sudo`, no Linux capabilities, and no way to gain privileges.
- Claude's login and settings live in a Docker volume, not your Mac's
  `~/.claude`.
- bd usage metrics are off (`BD_DISABLE_METRICS=1`, `DO_NOT_TRACK=1`), and
  their hostname is pointed at 127.0.0.1 as a backup.
- Your Mac's SSH agent isn't passed in (`SSH_AUTH_SOCK` is cleared).

**Not contained:**
- **The project folder.** Anything in the container can read, change or
  delete it. Commit often and push somewhere.
- **The network.** The agent needs it (Anthropic API, package registries),
  so it's open. Code in the container could upload project files. The next
  step up is an allowlist firewall; Anthropic's reference Claude Code dev
  container (github.com/anthropics/claude-code, `.devcontainer/`) has one
  you can adapt.
- **Git hooks.** `.git/` is inside the shared folder. If anything in the
  container sets `core.hooksPath` or writes `.git/hooks/*`, **git on your
  Mac** runs those scripts the next time you commit or pull there.
  `init-project.sh` uses `--skip-hooks`, and `check-host-safety.sh` warns on
  each start. Run it on your Mac too before using git there:
  `bash .devcontainer/check-host-safety.sh`.
- **Agent hook files in the repo.** `bd init` writes `.claude/settings.json`
  (and Codex/Cursor equivalents) that run `bd prime` at session start. If you
  run Claude Code on your Mac in this folder, that command runs on your Mac.
  It's harmless when `bd` isn't installed there, but treat these files as code.

## Pushing to GitHub

VS Code normally forwards your Mac's git credentials into the container, which
would let anything in it push to **every** repo you can access. Choose one:

- **Push from your Mac** (simplest): commit in the container, then
  `git push` in a Mac terminal. Run `check-host-safety.sh` first.
- **Push from the container with a narrow token:** turn off credential
  forwarding in your VS Code *user* settings
  (`"dev.containers.gitCredentialHelperConfigLocation": "none"`), then use a
  GitHub fine-grained token limited to this one repo. A token can't push
  `.github/workflows/` files unless it also has the **Workflows** permission;
  push those from your Mac.

**`gh` (GitHub CLI)** is installed by a feature in `devcontainer.json`, for
opening PRs. It doesn't use the forwarded git credentials; give it the same
narrow token: a fine-grained token for this repo only, with **Contents** and
**Pull requests** set to read and write. Then:

```bash
gh auth login --with-token   # paste the token, then Ctrl-D
gh auth setup-git            # optional: git push uses the same token
```

The login is kept in `~/.config/gh`, which is not in a volume: after a
rebuild, log in again.

## Changing things

- **Add a language or tool:** add a `features` entry in `devcontainer.json`,
  or an `apt-get` package in `Dockerfile`. Then run
  **Dev Containers: Rebuild Container**. There's no `sudo` at runtime, on purpose.
- **Upgrade bd:** in `Dockerfile`, change `BD_VERSION`, download the two
  linux tarballs, run
  `gh attestation verify <tarball> --repo gastownhall/beads` on each, and
  paste in their `shasum -a 256` values. Keep it in step with Snagboat's and
  tbd's dev containers, which share the same database format.
- **Reset Claude's login:** delete the `claude-config-*` volume in Docker Desktop.
