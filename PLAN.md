# Ruby Agent Harness — Implementation Plan

## Purpose

Build an always-on, persistent personal agent that runs on a VPS or a personal computer and can be reached through multiple communication channels. It retains useful state across conversations, executes tasks through tools, and gives the model a clean, reliable working environment.

“Ruby” is the project name; the implementation language remains open. Start with a single process and a single agent. Add complexity only when measurements or concrete use cases justify it.

## Design principles

### Token efficient

- Send only the instructions, conversation, tool definitions, and evidence needed for the next decision.
- Keep large tool results in an artifact store; return concise summaries and handles for selective retrieval.
- Discover tools on demand instead of loading every tool schema into every request.
- Preserve a stable prompt prefix to benefit from provider caching where available.
- Compact history at configurable thresholds, retaining the task, constraints, decisions, unresolved issues, and references to evidence. Keep original events recoverable.
- Track input, output, cached, and compaction tokens per task. Optimize total cost per successful task, not merely the size of individual requests.

### Model centric

Design the environment for the model to use effectively: clean context, understandable tools, consistent feedback, and recovery from imperfect tool calls. Model autonomy is one part of this, not the definition.

- Normalize and validate tool calls before execution; repair only unambiguous formatting errors automatically.
- Build a corrected model-facing history so malformed calls and repetitive failures do not keep confusing subsequent turns, while preserving the original audit trail.
- Use concise tool descriptions, predictable result shapes, and errors that state what can be corrected.

- Let the model choose the next action, tools, and when the task is complete within explicit policy and resource limits.
- Keep the runtime responsible for execution, persistence, permissions, cancellation, and budgets; avoid embedding task-specific reasoning in orchestration code.
- Expose tool errors and actionable execution feedback to the model so it can recover.
- Preserve provider-specific capabilities through adapters rather than forcing every model into the lowest common feature set.
- Treat plans and working notes as explicit model outputs when useful; do not depend on access to hidden reasoning.

### Modular

- Define small, versioned interfaces around components with distinct responsibilities.
- Keep the core loop independent of model providers, tool implementations, storage engines, and user interfaces.
- Use explicit configuration and dependency injection rather than global state.
- Start with built-in implementations behind interfaces; defer a plugin marketplace or elaborate discovery system.

## Initial scope

The first release runs as a background service on one host, with one model provider, a local administration CLI, and Signal and Telegram messaging channels. It includes durable conversations and tasks, basic tools, persistent memory, interruption/resume, token accounting, and bounded tool-call repair. Signal and Telegram are the primary user-facing channels. A Discord bot and a packaged dashboard with built-in chat are desired follow-on milestones.

Always-on means available and restartable, not continuously calling the model. Idle operation makes no model calls. User-configurable cron jobs and heartbeats are part of the primary release. Enabled schedules may wake the model; disabled schedules and otherwise idle operation make no model calls.

Defer multi-agent orchestration inside Ruby, remote workers, automatic model routing, and vector search. A handful of development agents can build this single-agent product.

## Confirmed direction and open decisions

Confirmed: persistent agent; VPS or personal-computer hosting; Signal and Telegram as primary channels; a desired Discord bot and packaged dashboard with built-in chat; token efficiency; modularity; and a runtime designed to make model interaction easier, including context cleaning and tool-call repair.

The following are proposals pending user preference:

| Decision | Proposed starting point | Why it matters |
| --- | --- | --- |
| Audience | One owner per installation | Simplifies identity, permissions, and memory |
| Primary channels (confirmed) | Signal and Telegram | Fits the owner’s existing daily workflow |
| Additional interfaces (desired) | Discord bot and packaged dashboard with built-in chat | Extends access through the same runtime |
| Conversation continuity (confirmed) | Default to separate conversations sharing memory; allow selective linking and full separation | Supports individual preferences without forcing one global history |
| Isolation (confirmed) | Configure conversation, memory, and sandbox independently for each routing profile | Allows shared memory with separate chats, or completely isolated agents |
| Autonomy | Work within configured permissions; persist requests for approval | Allows unattended operation with clear limits |
| Memory | Inspectable local records of preferences, facts, and ongoing work | Makes persistence understandable and editable |
| Proactivity (confirmed) | Customizable, toggleable cron jobs and heartbeats, with per-job action scope | Major actions normally follow user requests; scheduled major actions require explicit configuration |
| Deployment | One service, local database and artifacts, platform service-manager restart | Supports a VPS and personal computer with minimal operations |

Candidate first demo: message Ruby on Telegram, ask it to save a preference and perform a small tool-backed task, restart the service, then continue the explicitly linked conversation on Signal. It recalls the preference, recovers task state, and does not repeat completed effects. An injected malformed tool call is repaired or receives actionable feedback without corrupting future context.

## Architecture

```text
Signal / Telegram / Discord / dashboard chat / admin CLI
      |
Identity + routing + durable inbox/outbox
      |
Persistent service / agent runtime ---- Policy + budgets
      |
      +-- Context builder ---- Session events + artifacts
      +-- Model adapter
      +-- Tool registry ---- Tool executor
      +-- Event sink / usage metrics
```

| Component | Responsibility | Initial implementation |
| --- | --- | --- |
| Channel adapters | Receive/send messages and expose channel capabilities | Signal and Telegram first; Discord and dashboard follow |
| Message gateway | Authenticate sender, route conversations, deduplicate delivery | Durable inbox/outbox and explicit identity links |
| Scheduler | Persist cron/heartbeat configuration and enqueue bounded task triggers | Timezone-aware schedules with pause/resume and run history |
| Routing profiles | Resolve conversation, memory, sandbox and permission scopes | Independent bindings validated before execution |
| Service lifecycle | Startup, shutdown, health and restart recovery | Single host service with platform-specific installation |
| Memory store | Maintain inspectable facts, preferences and ongoing work | Local records with source, scope, timestamp and edit/delete support |
| Agent runtime | Drive the model/tool loop and task lifecycle | Single-process asynchronous loop |
| Model adapter | Translate requests, streamed responses, tool calls, usage, and errors | One provider, with capability metadata |
| Context builder | Assemble bounded context and perform recoverable compaction | Recent turns, task state, summaries, artifact references |
| Tool registry | Describe available tools and resolve requested schemas | Static catalog with on-demand schema loading |
| Tool executor | Validate arguments, enforce policy, run tools, bound results | Local execution with timeouts and cancellation |
| Session store | Persist ordered events and checkpoints | SQLite or append-only files; select during implementation |
| Artifact store | Retain large outputs and support ranged retrieval | Local files addressed by stable IDs |
| Policy engine | Authorize operations independently of model instructions | Workspace boundaries and explicit approval rules |
| Budget manager | Enforce token, tool-call, time, and optional monetary limits | Per-task limits and reserved capacity for final output |
| Telemetry | Record usage, latency, retries, and outcomes | Structured local events with sensitive content excluded by default |

## Core contracts

- **Routing profile:** matched channel/account/chat, conversation binding, memory namespace, sandbox ID, permission profile and allowed identities.
- **Scheduled trigger:** job ID, occurrence ID, trigger type, timezone, instruction, target routing profile, action scope, budgets and notification destination.
- **Inbound message:** channel, external message ID, verified sender identity, conversation ID, content, attachment references, and reply destination.
- **Outbound message:** delivery ID, destination, content, status, and retry metadata; acknowledge delivery separately from generating an answer.
- **Memory record:** content, owner/conversation scope, source event, timestamp, and supersession/deletion state.
- **Repair record:** original call reference, corrected call, repair rule, validation outcome, and execution ID.
- **Model request:** model configuration, context, selected tool schemas, generation limits, cancellation signal.
- **Model event:** text delta, tool-call delta, completed tool call, usage update, completion, or normalized error. Preserve native provider metadata when required to continue a session.
- **Tool definition:** name, version, description, input schema, permission category, output limits, and retry/idempotency metadata.
- **Tool result:** status, bounded content, artifact references, timing, and structured error details.
- **Session event:** session ID, sequence number, event type, timestamp, payload, and related operation IDs.
- **Task state:** objective, constraints, status, budget consumed, pending actions, and checkpoint reference.

Tool outputs are untrusted data. They cannot modify runtime permissions or override user instructions.

## Execution loop

1. Authenticate and deduplicate the incoming message or scheduled trigger, persist it, and resolve its configured conversation, memory, sandbox and permission scopes. Load or create the session and task. Serialize turns within a conversation; queue follow-up messages and prioritize cancellation.
2. Check cancellation, permissions, and remaining budget.
3. Assemble context within the model's input limit, reserving room for output and tool feedback.
4. Call the model and stream user-visible output.
5. If it requests tools, normalize and validate calls, apply bounded unambiguous repairs, and authorize the resulting operation before execution. Persist call intent before starting work.
6. Execute authorized tools with bounded output, deadlines, and cancellation. Persist results and store large outputs as artifacts.
7. Return results to the model and repeat until completion, a request for user input, cancellation, or a resource limit.
8. Persist the final state and enqueue the reply for delivery to its originating channel. Report the outcome, unfinished work, and usage. Retry delivery independently of task execution.

Use explicit states: `running`, `waiting_for_user`, `completed`, `cancelled`, `budget_exhausted`, and `failed`. Completion means the model reported completion; task evaluations independently assess success.

## Context strategy

Construct each request from a stable instruction prefix, the current task and constraints, a compact checkpoint, recent relevant turns, and selected tool results.

Start with deterministic retention rules rather than a separate model-driven retrieval system. Preserve active tool-call/result pairs and provider-required continuation data. Measure actual request usage when available and use conservative estimates before sending requests.

When compacting, keep the original transcript and record the source event range covered by the summary. Test that important constraints survive compaction. If a summary lacks needed evidence, retrieve original events or artifacts rather than inventing details.

## Tool-call repair and clean history

Keep two representations: immutable execution events for audit/recovery, and a derived model-facing conversation. Cleaning changes the latter, never what actually happened.

1. Assemble complete streamed calls before parsing; never execute a partial call.
2. Apply only deterministic, unambiguous repairs, such as stripping a surrounding JSON code fence. Do not guess missing paths, recipients, tool names, or consequential arguments.
3. Validate the repaired call against the tool schema, then run the usual authorization checks. Repairs grant no extra permissions.
4. If intent is ambiguous, return a compact validation error and let the model supply a corrected call. Bound correction attempts per operation and charge them to the task budget.
5. In subsequent context, present the valid executed call paired with its real result. Retain a compact correction note where relevant; collapse superseded malformed attempts without fabricating success or changing tool-call IDs inconsistently.
6. Preserve provider-required signed/opaque continuation data. When a provider forbids rewriting prior turns, use its supported continuation or rebuild a valid context from a checkpoint rather than mutating protected history.

Test syntax repair, ambiguous arguments, repeated failures, permission checks after repair, provider history validity, and duplicate-effect prevention. Measure repair success alongside token savings and task success.

## Persistent memory and channel behavior

- Separate conversation history, current task state, and long-term memory. Persistence does not require sending all history on every turn.
- Retrieve a bounded set of relevant memory records. Start with explicit user facts and task summaries; distinguish model-inferred notes from confirmed preferences.
- Support inspecting, correcting, and forgetting memory. Deletion must invalidate derived summaries and retrieval indexes; document any retained audit data separately.
- Link identities across channels through explicit owner configuration or verification, never display-name matching.
- Default to separate conversations sharing the authorized owner memory namespace. Allow specific chats/channels to share a conversation, use different memory namespaces, or bind to different sandboxes. Group chats do not inherit private owner memory automatically.
- Keep message ingestion responsive during a task. Persist queued input and define where steering is incorporated; cancellation should not wait for the next model call to finish.
- Use durable delivery IDs. Where a channel cannot deduplicate outgoing sends, surface uncertain delivery instead of promising exactly-once delivery or rerunning the task.
- Persist approval requests and accept responses only from an authorized identity, bound to the pending operation.
- On host wake or restart, recover queued work. A personal computer is unavailable while asleep; do not imply uninterrupted availability without an awake host.

## Configurable conversations, memory, and sandboxes

Treat these as independent settings rather than a single shared/private switch:

| Setting | Controls | Examples |
| --- | --- | --- |
| Conversation binding | Which messages share conversational history | Separate Signal/Telegram chats; selectively linked Signal and dashboard chat |
| Memory namespace | Which durable facts and preferences can be retrieved | Shared personal memory; isolated work memory; no durable memory |
| Sandbox binding | Where tools run and which files/resources are available | Personal workspace; isolated work environment |
| Permission profile | Which actions are allowed and require approval | Interactive owner permissions; restricted heartbeat permissions |

A routing profile binds a channel account and a specific chat/thread to those settings. Ship the owner's preferred default: separate conversations, shared personal memory, and a default execution environment. Offer explicit profiles for linked conversations, fully separate memory, and isolated sandboxes. Specific route rules take precedence over defaults; reject ambiguous rules.

Resolve and authorize bindings before memory retrieval or tool execution. Carry scope IDs through events, artifacts, checkpoints, queues and caches so isolation holds beyond the prompt. A model cannot change its own bindings. Sharing memory does not grant access to another sandbox or its credentials.

A workspace directory is not a security sandbox. Use an enforceable process/container boundary for profiles advertised as isolated, with explicitly scoped filesystem, environment, credentials and network access. Document the supported isolation backend for each target host; reject unavailable isolation modes instead of silently degrading them.

Configuration changes apply to new turns/runs; in-flight work retains its original scope. Linking existing conversations or moving memory requires an explicit migration choice, not automatic transcript merging. Serialize turns that share a conversation and coordinate overlapping sandbox writes even when conversations are separate.

## Cron jobs and heartbeats

The user can create, inspect, edit, enable, disable and delete schedules. Support administration through configuration/CLI initially and the dashboard when available. Chat-based changes must be authorized user requests and resolve to explicit persisted settings.

- **Cron job:** execute configured instructions at calendar times in a specified timezone.
- **Heartbeat:** periodically check configured conditions or ongoing work and act within its configured scope.
- Both use the normal runtime, tools, permissions and persisted task lifecycle. The scheduler enqueues triggers; it does not create a separate agent implementation.
- Every job specifies its instructions, cadence/timezone, enabled state, routing profile, action permissions, per-run and aggregate budgets, timeout, notification destination and notification rules.
- Default proactive runs to small checks and meaningful-change notifications. Major actions normally originate from an interactive user request. A job can perform major actions when the user explicitly grants the required capabilities in that job's configuration.
- Enforce concrete capabilities and limits, not a model's subjective classification of an action as “big.” A job's effective permissions are the intersection of its grant and the target profile's permissions.
- A schedule needing approval pauses and notifies its authorized owner; it cannot self-approve. Model-generated schedule changes cannot expand permissions without user authorization.
- Default to no overlapping runs for the same job and coalesce missed occurrences into at most one catch-up run. Make overlap, missed-run handling, timezone/DST behavior and delivery retries explicit settings.
- Persist an occurrence ID before execution to prevent duplicate scheduler delivery from repeating work after a restart. Retain run history, outcomes and next-run time.
- Disabling a job prevents new runs; separately offer cancellation of an active run. A global scheduler toggle disables all new proactive triggers while leaving interactive chat available.
- Default scheduled checks to their own task contexts with access to the configured memory, keeping repetitive heartbeat details out of interactive history. Let the user explicitly choose a linked conversation instead.
- Apply backoff and a configurable failure threshold to broken jobs. Aggregate budgets prevent many individually cheap heartbeats from creating an unexpectedly large bill.

Acceptance examples: a disabled heartbeat never calls the model; an enabled check cannot perform an ungranted write; an explicitly authorized scheduled task can; restart does not duplicate an occurrence; separate conversations can share memory while an isolated profile cannot retrieve it or access its sandbox.

## Reliability and permissions

- Require approval according to configured operation risk and the user's existing authorization; enforce this outside the model.
- Limit file access to configured roots and define network and command execution permissions explicitly.
- Retry transient provider failures with bounded backoff. Retry tools automatically only when doing so is safe.
- On resume, reconcile unfinished operations. Never blindly repeat an operation that may already have caused an external effect.
- Keep credentials outside prompts and logs; redact sensitive fields in diagnostics.
- Distinguish malformed model output, provider failure, tool failure, denied permission, and exhausted budget so each has a clear recovery path.

## Build phases

### 1. Minimal vertical slice

Choose the implementation language and first provider. Implement the core contracts, background service, CLI, Telegram channel, streaming model adapter, agent loop, and a few bounded tools: read a file, list files, and write inside the workspace.

**Exit criteria:** the agent receives a message through Telegram, completes a small tool-backed task, delivers a reply, and reports usage; idle service operation makes no model calls. Tests cover invalid tool arguments and tool failures.

### 2. Durable and controlled execution

Add durable inbox/outbox, session persistence, artifact storage, basic scoped memory, policy enforcement, routing profiles, scoped sandboxes, budgets, cancellation, and resume. Add command execution only after its permissions and process lifecycle are defined.

**Exit criteria:** an interrupted session resumes with correct history; denied operations never execute; uncertain external effects are surfaced instead of replayed automatically; duplicate inbound messages do not rerun tasks and private memory stays within its scope.

### 3. Scheduling and token efficiency

Add persistent cron/heartbeat scheduling, per-job permissions, user toggles and aggregate budgets. Add output limits, selective artifact reads, on-demand tool schemas, stable prompt prefixes, checkpoint compaction, and the tool-call repair/clean-history pipeline. Establish a full-history baseline before optimization.

**Exit criteria:** scheduler permission, disable, restart and missed-run acceptance examples pass. On a fixed task suite, the optimized runtime reduces median input tokens by an initial target of 30% relative to the baseline without reducing observed task success. Report total tokens and latency too, including compaction overhead; revise the target only with recorded evidence.

### 4. Demonstrate modularity

Add Signal, a second model adapter, and an independently implemented tool module. Run shared contract tests against both adapters. Document provider-specific extensions and unsupported capabilities.

**Exit criteria:** switching providers, adding a tool, or adding a channel requires configuration or a new module, with no changes to the core loop; the cross-channel restart demo passes.

### 5. Harden and release the primary channels

Document VPS and personal-computer service setup, configuration, permissions, channel/tool authoring, backups, session recovery, and usage reporting. Run repeatable evaluations and failure-injection tests before tagging an initial release.

**Exit criteria:** a fresh installation can run and resume the documented example tasks; known limitations are documented; evaluations establish a reproducible baseline for later changes.

### 6. Additional interfaces

Add a Discord bot and a packaged dashboard with built-in chat. These are desired extensions; do not make the primary Signal/Telegram release depend on completing them.

The dashboard should start with the Ruby installation, with no separate frontend development setup required. Include chat, conversation/task status, pending approvals, memory inspection/editing, schedule editing and toggles, routing profiles, and usage totals. Serve bundled assets through an authenticated API; chat uses the same message routing and execution path as external channels. Use incremental updates for active tasks and recover visible state after reconnecting.

**Exit criteria:** Discord and dashboard chat can run a task, show its outcome, and continue an explicitly linked conversation without interface-specific changes to the agent loop. Dashboard reconnects do not duplicate messages or lose pending approvals.

## Channel implementation boundaries

- Prioritize Signal and Telegram equally as product requirements. Implement Telegram as the proposed first vertical slice, while validating the Signal integration approach during foundation work so it cannot become a late blocker.
- Before implementation, verify the supported integration mechanisms for both channels, including Signal account/linking requirements, hosting dependencies, reconnect behavior, and delivery limitations. The specific libraries or bridges remain undecided.
- Keep channel-specific formatting, message length limits, attachments, edits, delivery receipts, and reconnect behavior inside adapters. Expose capabilities instead of assuming every channel supports streaming or editing.
- Start with owner-authorized direct messages. Define Discord server/channel allowlists and group-chat memory rules before enabling shared conversations.
- Package any required Signal bridge as a documented service dependency with health checks and restart instructions. Do not assume it works like a conventional bot API.
- Keep the dashboard's authentication, API, and assets distinct from the agent loop. Default to local access; VPS remote access requires an explicitly configured authenticated connection.
- Defer voice, rich media understanding, and channel-specific interactive controls until text conversations and delivery recovery are reliable.

## Evaluation plan

Use a small, versioned suite covering direct answers, file edits, multi-step tool work, large outputs, tool errors, long-session compaction, permission denial, interruption, resume, duplicate messages, failed reply delivery, cross-channel identity, private memory/sandbox isolation, routing configuration, cron/heartbeat toggles, scheduled permissions, missed runs, and restart recovery.

Track task success, input/output/cached tokens, total cost where known, end-to-end latency, tool calls, retries, and context loss. Compare runs with the same model, settings, tools, and tasks; repeat stochastic tasks and report variation.

Prioritize tests at boundaries: adapter translation, tool validation, authorization, budget enforcement, event ordering, and crash recovery. Use end-to-end tasks to establish that efficiency changes preserve useful behavior.

## First implementation decisions

1. Choose a language based on maintainability, provider support, and deployment needs; the project name does not decide it.
2. Choose the first model provider and one representative task to serve as the vertical slice.
3. Set default workspace permissions and per-task budgets.
4. Implement the smallest complete loop, then measure before adding abstractions or optimization.

## Build with a small agent team

Use three implementation agents and one integration lead. These are development assignments, not components that require separate services. Keep one repository and one build system; avoid turning every interface into a separately published package.

### Ownership

Paths below are proposed boundaries; adapt extensions and layout after choosing the language.

| Owner | Owned areas | Deliverables |
| --- | --- | --- |
| Integration lead | `contracts/`, `runtime/`, `service/`, `scheduler/`, root configuration, integration tests | Shared types, scaffold, task loop, routing, scheduler, budgets, lifecycle and integration |
| Model/channel agent | `models/`, `channels/`, `cli/`, `dashboard/`, related tests | Providers, streaming, usage, channel adapters, message normalization; dashboard in a later pass |
| Tools agent | `tools/`, `policy/`, `repair/`, related tests | Tools, validation/repair, permissions, sandbox enforcement, bounded execution and cancellation |
| State/context agent | `sessions/`, `artifacts/`, `context/`, `memory/`, `delivery/`, related tests | Durable inbox/outbox and job records, scoped memory, clean history, checkpoints and recovery |

With three agents, the lead also owns the model/channel assignment, delivered sequentially. With two, work sequentially across the same boundaries. Do not add agents merely to occupy every module.

### Agree on contracts before parallel implementation

The lead first creates the smallest runnable scaffold and shared contract definitions. Include a scripted fake model, an in-memory session store, and a harmless fake tool so the full loop can run without credentials or paid calls.

Settle these shared behaviors before handing out implementation work:

- Who owns event ordering and IDs: the runtime assigns operation IDs; the session store appends events in sequence.
- Who owns permissions: the executor consults policy before every tool operation; models cannot authorize themselves.
- Who owns context limits: the context builder fits requests into the allowance supplied by the runtime's budget manager.
- Who owns usage: adapters report actual usage when available, distinguishing unknown values from zero; the runtime aggregates it.
- Who owns persistence: the runtime records model/tool lifecycle events; implementations do not create competing transcripts.
- How cancellation and failures propagate: shared cancellation signals and explicit error categories, with no silent retries of unsafe operations.
- How approvals pause work: an approval-needed result leads to a persisted pending operation and `waiting_for_user` state.
- How channels share state: adapters normalize messages; the runtime routes verified identities and the state module owns durable inbox/outbox records.
- How scheduled work runs: the lead owns scheduler logic; the state agent owns durable job/occurrence records. Scheduled triggers enter the same runtime with explicit grants and scope bindings.
- How isolation works: the runtime resolves routing profiles; the state module enforces retrieval scope; the tools module enforces sandbox and permission scope.
- How repairs reach context: the tools agent emits repair records; the state/context agent constructs valid cleaned history using adapter capabilities.
- How provider continuation works: opaque provider state survives persistence and compaction through an adapter-defined interface.

Write sample request, tool-call, result, failure, and resumed-session fixtures. Contract tests should check externally visible behavior, not internal implementation details. Interfaces may evolve, but the lead coordinates changes and updates dependent modules together.

### Parallel work and integration order

1. **Foundation — lead:** select language/provider, validate Signal integration feasibility, establish contracts, fake implementations, and a single test command. Exit with a complete simulated task.
2. **First parallel pass — three owners:** implement one real provider and Telegram channel; workspace tools with policy and basic repair; durable storage, inbox/outbox and context assembly. Each works against shared fixtures and fakes rather than waiting for another agent's implementation.
3. **First integration — lead:** connect all three to the runtime and run the candidate demo. Resolve interface mismatches before starting new features.
4. **Second parallel pass — same owners:** harden streams and add Signal; tool cancellation and repair edges; scoped memory, delivery recovery and context cleaning. The lead adds cron/heartbeat triggers, service restart, task budgets and cross-channel integration coverage; the state and tools owners verify memory and sandbox isolation.
5. **Acceptance — lead with focused owner fixes:** run the fixed evaluation suite, compare token usage, and document remaining limitations. Add the second provider only after the first path passes.

The build phases above define feature milestones; these passes define who delivers them. Parallel development never requires shipping an unfinished foundation.

### Keep agent work bounded and inexpensive

- Give each assignment a concrete outcome, owned paths, contract version, dependencies, and acceptance checks. An agent should not need the entire planning conversation to begin.
- Use separate branches/worktrees where available. Within a shared checkout, keep file ownership exclusive. The lead owns dependency manifests, lockfiles, shared contracts, and root configuration.
- Ask agents to propose cross-boundary changes to the lead instead of editing another owner's files.
- Make ordinary development tests deterministic and offline. Reserve paid model calls for a small integration smoke test and deliberate evaluations with a budget.
- Persist concise handoffs: changed files, verified behavior, checks run, unresolved issues, and the next integration action. Avoid copying full transcripts between agents.
- Require each handoff to include runnable work and evidence of acceptance checks; a descriptive report alone is insufficient.
- Integrate after each pass, not after all modules are independently declared finished.

### Reusable assignment brief

```text
Outcome: <one independently reviewable result>
Own: <exclusive directories/files>
Depend on: <shared contracts and fixtures>
Implement: <bounded feature scope>
Do not expand into: <adjacent owner's responsibilities>
Acceptance: <observable behavior and required checks>
Handoff: <changes, checks, limitations, integration notes>
```

### Ready to start implementation when

- The language, provider, Signal integration approach, and autonomy defaults are selected; Signal and Telegram are already the chosen primary channels.
- The first demo has an explicit pass/fail condition.
- Contracts and file ownership are small enough to fit in an assignment brief.
- Each owner can develop and test independently using the provided fakes.
- One lead is responsible for the working whole, not just individual modules.
