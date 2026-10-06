# service

Generates and installs a per-user OS service that runs `garnet start` (foreground, graceful on SIGTERM).

- Public API: `planService` (pure), `resolveService`, `installedServices`, `serviceHomeOf`, `checkServiceName`, `installService`, `uninstallService`, `serviceStatus`, `restartService`, `defaultEntry`.
- Linux: systemd user unit `~/.config/systemd/user/garnet.service`. macOS: launchd agent `~/Library/LaunchAgents/dev.garnet.agent.plist`. Other platforms get `{ unsupported }`.
- Several instances (one per GARNET_HOME) coexist through an instance name (`PlanOptions.name`, `/^[a-z0-9][a-z0-9-]{0,31}$/`): `garnet-<name>.service` / `dev.garnet.agent.<name>`. Nothing records the name: `installedServices` lists the Garnet unit files and reads back the `GARNET_HOME` each runs (`serviceHomeOf`), and `resolveService` picks the explicit name, else the instance already installed for this home, else the default. It reports a `conflict` when that file runs another home; the CLI refuses to install over it without `--force`, and doctor/setup never treat another home's service as this one's.
- Secrets live in `<GARNET_HOME>/env` (mode 0600, `KEY=value` lines), never in the unit or plist. systemd reads it via `EnvironmentFile=-`; launchd sources it from a `/bin/sh -c` wrapper.
- Install is re-runnable and (re)starts the service, so a reinstall picks up a new unit or plist: systemd `daemon-reload`, `enable`, `restart`; launchd `bootout` (its failure is ignored: `commands.prepare`), then `bootstrap`.
- Stop timeout is 60 s (`TimeoutStopSec`, launchd `ExitTimeOut`): shutdown may take ~45 s (API grace, task drain, delivery flush). The plist sets a fixed `PATH` (node's directory, Homebrew, /usr/local/bin, system dirs) because launchd's default lacks them.
- Side effects (fs, process spawning) go through injectable `ServiceDeps`. Tests never call real systemctl or launchctl.
- Failed commands are reported in the result (code, stderr), never thrown.
- Must not: run `loginctl enable-linger` (we only print the hint), use a shell for spawning, or read secrets.
