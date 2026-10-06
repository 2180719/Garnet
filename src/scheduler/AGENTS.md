# scheduler

Cron jobs and heartbeats defined in config (`jobs`, `scheduler`). The scheduler only decides *when*; every run goes through the gateway and the normal agent loop.

- Public API: `Scheduler` (start, stop, tick, runNow, resume), `NOTHING`.
- Each job runs in its own conversation (`job:<id>`) with its own agent: its permission grant intersected with the owner's (jobs default to read-only) and its own token and time budget.
- An occurrence ID (`<job>@<scheduled time>`) is claimed in the database before a run, so a slot runs at most once across restarts. New jobs start from "now" (no backfill). Missed occurrences coalesce into one catch-up run, or are recorded as `missed` when `catchUp` is false. A job never overlaps itself.
- Cost controls: disabled or paused jobs and the global switch never call the model; a pre-check (`file_changed`, `url_changed`) skips the model when nothing changed; a 24-hour token budget per job; 3 consecutive failures pause the job and notify the owner. A run cancelled because Ruby is shutting down is recorded as `interrupted` and does not count as a failure.
- Results: with `notifyWhen: on_change` the model replies `NOTHING_TO_REPORT` when there is nothing worth saying, and the owner is not messaged. Approval requests and failures are always sent.
- Cron parsing and time zones live in `config/cron.ts` (so config validation can use them). DST: local times skipped by spring-forward never fire; a wall-clock minute repeated by fall-back fires once (its first instance), except for jobs whose hour field is `*`, which follow elapsed time (as cronie does).
