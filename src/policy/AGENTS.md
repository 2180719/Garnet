# policy

Decides whether an operation may run, independently of anything the model says.

- Public API: `Policy` (`check`, `intersect`), `Approver` and `ApprovalRequest`, `deferAll`, `denyAll`, `resolveInWorkspace`.
- `allow` runs; `ask` goes to the `Approver` (`approved`, `denied`, or `deferred`, which pauses the task); `deny` never runs.
- `resolveInWorkspace` follows symlinks and rejects paths outside the workspace. A workspace is a scope, not a security sandbox; real isolation needs a sandbox backend (see PLAN.md).
- Must not: execute tools or persist state.
