# service

Generates and installs a per-user OS service that runs `ruby start` (foreground, graceful on SIGTERM).

- Public API: `planService` (pure), `installService`, `uninstallService`, `serviceStatus`, `restartService`, `defaultEntry`.
- Linux: systemd user unit `~/.config/systemd/user/ruby.service`. macOS: launchd agent `~/Library/LaunchAgents/dev.ruby.agent.plist`. Other platforms get `{ unsupported }`.
- Secrets live in `<RUBY_HOME>/env` (mode 0600, `KEY=value` lines), never in the unit or plist. systemd reads it via `EnvironmentFile=-`; launchd sources it from a `/bin/sh -c` wrapper.
- Side effects (fs, process spawning) go through injectable `ServiceDeps`. Tests never call real systemctl or launchctl.
- Failed commands are reported in the result (code, stderr), never thrown.
- Must not: run `loginctl enable-linger` (we only print the hint), use a shell for spawning, or read secrets.
