# policy

Decides whether an operation may run, independently of anything the model says.

- Public API: `Policy` (`check(capability, { targets, taint })`, `intersect`), `PolicyOptions`/`Containment`/`DEFAULT_CONTAINMENT`, `Approver` and `ApprovalRequest`, `deferAll`, `denyAll`, `resolveInWorkspace`, URL helpers (`normalizeUrl`, `urlsInText`, `hostMatches`, `hostOf`).
- `allow` runs; `ask` goes to the `Approver` (`approved`, `denied`, or `deferred`, which pauses the task); `deny` never runs.
- Host scopes: with `net.fetch: ask`, a fetch whose every target host matches `allowHosts` (`example.com`, `*.example.com` for subdomains only) is allowed.
- Containment (prompt injection): when the session's `SessionTaint` has sources, every capability in `containment.escalate` that would be `allow` becomes `ask`, and the decision carries `taint` (the sources), which the executor puts on the `ApprovalRequest` and in its summary. `deny` stays `deny`; `ask` stays `ask`. The one exemption is `net.fetch` to URLs that carry no data the model composed: a URL the owner wrote, an owner-configured endpoint (`trustedEndpoints`, path-segment prefix), or (with `fetchSeenUrls`) a URL an untrusted tool reported verbatim. An allow-listed host is *not* exempt: anyone can own a path on a popular host and read its logs (cf. Claude Code CVE-2026-54316). Residual risk accepted with `fetchSeenUrls`: a page that plants several links learns which one was chosen.
- Approvers must not apply standing "always allow" answers to a request with `taint`; persisted approvals stay single-use grants for the exact operation.
- `intersect` keeps the owner's options (containment, scopes), so a job's narrower grant is contained the same way.
- `resolveInWorkspace` follows symlinks and rejects paths outside the workspace, dangling symlinks, and paths that fail to resolve for any reason other than ENOENT. Writers must still re-check at write time and not follow a final symlink (see `write_file`). A workspace is a scope, not a security sandbox; real isolation needs a sandbox backend (see PLAN.md).
- Must not: execute tools or persist state.
