# sandbox

Runs shell commands for the `exec` capability (`run_command` in `src/tools/builtin/exec.ts`).

- Public API: `Sandbox` (`run`, `check`, `kind`, `isolated`, `workspace`), `DockerSandbox`, `LocalSandbox`, `createSandbox`, `assertSandboxReady`, `openSandbox`.
- `DockerSandbox` is the isolation boundary. Each run is a fresh `docker run --rm` with: `--network none` (unless configured `bridge`), memory/swap, CPU and PID limits, `--cap-drop ALL`, `no-new-privileges`, read-only root, a 64 MB `/tmp` tmpfs (nosuid, nodev), the host uid:gid, `--pull never`, and only the workspace bind-mounted at `/workspace`. The docker client gets an allowlisted environment; the container gets `HOME=/tmp` plus explicit `NAME=value` variables only.
- `LocalSandbox` runs `sh -c` on the host with a minimal environment. It is **not** a security boundary (`isolated: false`): the command can do anything Ruby's user can. Only for owners who choose it explicitly.
- Never fall back from an isolated backend to `local`. An unavailable backend is a `config` error (`assertSandboxReady`, and `run_command` checks on first use).
- Invariants: no host shell (`spawn` with an args array); `cwd` resolved with `resolveInWorkspace` and must exist; stdout/stderr each capped at `maxOutputBytes` (head kept, rest drained); on timeout or abort the container is `docker kill`ed (retried until the client exits, since it may still be starting) and then `docker rm -f`ed, so no container outlives `run()`. Local runs kill the whole process group, also after a normal exit.
- `run()` never pulls images; `check()` reports how to pull a missing one. `DockerSandbox.cleanup()` removes containers labelled for this workspace left by a crash.
- Tests: `sandbox.test.ts` uses a fake `spawn` (exact argument list, no env leakage, kill paths). `docker.test.ts` runs against real Docker and skips with a reason when the daemon or `busybox` image is unavailable.
- Must not: decide policy (the executor does), or read config (the composition root passes options).
