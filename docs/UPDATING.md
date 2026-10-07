# Updating Garnet

`garnet update` updates an install made by `install.sh` in place. Your data in `~/.garnet` (`GARNET_HOME`) is never read or written by the update itself.

```sh
garnet update --check     # look only: exit 0 = up to date, exit 10 = update available
garnet update             # asks first
garnet update -y          # no questions; also restarts the background service
garnet update --ref v0.2.0   # a branch or tag instead of the branch this checkout tracks
garnet update --reinstall    # run npm ci even if dependencies did not change
```

## What it does

1. Finds the install from the running code (the repository above `src/cli`), not from the environment.
2. Refuses, and changes nothing, when that directory is not a git checkout (reinstall with `install.sh`), has uncommitted changes to tracked files, or has local commits (a development checkout: update it with git yourself).
3. Fetches the branch the checkout tracks (or `--ref`) and shows the current and latest commit, how many commits you are behind, up to 20 subjects, and new `CHANGELOG.md` headings.
4. Fast-forwards. It never uses `git reset --hard`, `git clean` or force.
5. Runs `npm ci --omit=dev` only when `package.json` or `package-lock.json` changed (or with `--reinstall`).
6. Smoke-checks the new code (`garnet --version` loads the whole CLI without a network, a model or secrets).
7. If anything fails after the checkout moved, it goes back to the previous commit (`git checkout`), restores the old dependencies when it had touched them, checks that the old version loads, and says exactly what happened. The old version stays in place.
8. After a successful update it runs `garnet config check` with the new code and reports problems instead of crashing. Config migrations run on load and keep a backup, as always. With invalid config the service is not restarted.
9. If a background service runs this `GARNET_HOME`, it offers to restart it (`-y` does it). If the new version's unit file differs from the installed one, it reinstalls the service instead.
10. Reports (never rewrites) a missing `garnet` shim, or one that points at another install.

Then run `garnet doctor`.

## The restart window

The service is not stopped while the checkout moves. It keeps running the code it already loaded, and a restart is the only interruption: up to about 45 seconds while it finishes work and flushes deliveries, then it starts on the new code. Updating without restarting leaves the service on the old code until `garnet service restart`.

## One updater at a time

A lock file `.git/garnet-update.lock` in the install directory holds the updater's pid. A second `garnet update` is refused while that process is alive; a lock left by a dead process is ignored.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Updated, or already up to date (`--check`: up to date) |
| 1 | Refused or failed (a failed update was rolled back) |
| 2 | Usage error |
| 10 | `--check` only: an update is available |

## Not covered

`garnet update` does not check for updates by itself or in the background, and `garnet doctor` does not report new versions. Use `garnet update --check` (for example from cron: exit 10 means "update available").
