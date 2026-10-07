# Built-in skills and connectors

Garnet ships a few optional extras. **All of them are off** until you turn them on, either everywhere or for one channel, chat, API key, scheduled job or shared conversation.

- **Built-in skills** are instructions (`SKILL.md`, agentskills.io format) shipped in `src/skills/builtin/`. They cost nothing until enabled; then their name and one-line description join the skills index, and Garnet loads the body with `skill_view` when it needs it.
- **Connectors** are small integrations with outside services. Each adds one tool. They run through the same policy as `web_fetch`: the `net.fetch` permission, `web.allowHosts`, and untrusted-content containment.

## Turning things on

```sh
garnet connectors list                                    # what exists, what is on, which secrets are set
garnet connectors enable weather                          # everywhere
garnet connectors enable calendar --channel telegram      # only in Telegram chats
garnet connectors disable calendar --channel telegram:12345   # ...except this one chat
garnet skills builtin                                     # the built-in skills
garnet skills enable daily-briefing --channel telegram
garnet skills effective --channel telegram:12345          # what a new conversation there gets
garnet connectors reset calendar --channel telegram:12345 # drop an override (inherit again)
```

The same settings in `config.json`:

```json
{
  "skills": {
    "enabled": ["web-research"],
    "channels": { "telegram": { "enable": ["daily-briefing"], "disable": [] } }
  },
  "connectors": {
    "enabled": ["weather"],
    "channels": {
      "telegram": { "enable": ["calendar"], "disable": [] },
      "telegram:12345": { "enable": [], "disable": ["calendar"] },
      "route:family": { "enable": [], "disable": ["weather"] }
    },
    "weather": { "units": "metric", "location": "Lisbon" }
  }
}
```

### Scopes

| Scope | Covers |
| --- | --- |
| `telegram`, `discord`, `signal` | Every chat on that channel |
| `telegram:<chatId>` (`signal:group:<id>` for Signal groups) | One chat |
| `route:<name>` | A shared conversation from `routes` (see below: every chat and channel linked into it also counts) |
| `api`, `api:<keyId>` | The HTTP API and dashboard, or one API key |
| `job`, `job:<id>` | Scheduled runs, or one job |
| `cli` | The terminal chat (`garnet chat`) |

A conversation starts from the global `enabled` list, then applies its channel's override, then its chat's (or key's, job's). The narrowest scope wins.

#### Shared conversations (routes)

A chat linked into a shared conversation by `routes` has no conversation of its own: its messages go to `route:<name>`, which several chats read and drive. So its set is decided with every chat and channel that feeds the route, and the safe direction wins:

1. A `disable` in any scope that feeds the route (the channel or chat of any route entry pointing at it, and for a channel-wide route also each chat on that channel with its own override) or in `route:<name>` itself turns the item off for the whole conversation.
2. Otherwise an `enable` on `route:<name>` turns it on.
3. Otherwise it is on only when it is on for every chat that feeds the route (the global list, then that chat's channel and chat enables). One chat enabling it is not enough; enable it on `route:<name>` instead.

For example, with `telegram:42` and `discord:7` both routed to `family`, `github` on globally and a disable for `telegram` or `telegram:42`, the `family` conversation does not get `github`, on Discord either. `garnet connectors effective --channel telegram:42` (and `list`) resolve a routed chat the same way the running service does and say which route it belongs to.

Like any change, this applies to conversations that start after it: a shared conversation that already started keeps the set it froze until `/new`.

### When changes apply

The tool set and system prompt are fixed for a conversation (prompt caching and signed thinking depend on it). So the set of skills and connectors is chosen when a conversation starts, recorded with it, and kept for its whole life, compaction included. After changing config:

1. restart the service (`garnet service restart`), then
2. send `/new` in a chat (or start a new terminal chat) to get the new set.

Turning a connector off does not take it away from conversations that already have it, even after a restart: Garnet keeps its tool loaded for them until they end with `/new`. Denying `net.fetch` is the switch that removes every connector at once.

## Policy and safety

- **Permissions.** Every connector call needs `net.fetch`; with `net.fetch: deny` no connector is offered at all. With `ask` (the default) each call asks for your approval and shows the exact URLs. Add a connector's hosts to `web.allowHosts` to let it run without asking. A GitHub comment also needs `message.send` (ask by default); its approval is labelled `message.send` and shows the full text, and in the terminal chat an "always" for a read never covers a comment.
- **Containment.** Connector output (issue comments, calendar invitations, even place names) is written by other people, so it is treated as untrusted: once a conversation has read it, consequential actions ask first, and connector calls themselves ask again even for allowed hosts, because the model writes the query.
- **Secrets.** Config holds only the *name* of an environment variable or stored secret (`tokenEnv`, `urlEnv`). Store values with `garnet secrets set NAME`. They are read when a call runs, never put in prompts, output, approvals, logs or errors. `garnet doctor` reports whether each one is set, never its value.
- **Admin API.** Where a credential is sent (`connectors.github.apiUrl`, `repos`, `write`, every `*Env`) cannot be changed through the dashboard or admin API, only by editing `config.json`.
- **Network.** Connectors use the same SSRF-guarded client as `web_fetch`: public addresses only, pinned DNS, redirects re-checked, credentials dropped on a cross-origin redirect, capped bodies. An address you configured yourself (a GitHub Enterprise server, your calendar feed) may be on your own network.

## The connectors

### calendar (read-only)

Your events for a day or a range, in your time zone (`timezone` in config).

1. Get your calendar's private ICS address: Google Calendar "Settings > your calendar > Secret address in iCal format"; iCloud "Public Calendar" link; Fastmail "Calendars > Export/Share"; Outlook "Publish calendar > ICS"; Nextcloud "Copy subscription link" (`https://user:app-password@host/...?export` works).
2. `garnet secrets set GARNET_CALENDAR_URL` and paste it. It is a secret because the address itself is the password. Errors name only the feed's host, never its path or query.
3. `garnet connectors enable calendar` (optionally add the feed host to `web.allowHosts`).

It understands time zones, all-day events, durations, cancelled events, moved and excluded occurrences, and daily, weekly, monthly and yearly repeats (with intervals, counts, end dates, weekdays like "last Friday", days of the month and months, combined as the iCalendar standard says). Days follow the calendar, so an all-day event on a clock-change day still ends at local midnight. Anything else (for example `BYSETPOS`, hourly repeats, Windows time-zone names) is shown with a note instead of guessed. Settings: `connectors.calendar.urlEnv`, `maxDays`.

### github

Search issues and pull requests, list a repository's, read one with its comments, and read your unread notifications. Optionally, comment.

1. Create a fine-grained token (read access to issues, pull requests and notifications; add write access to issues for comments). `garnet secrets set GITHUB_TOKEN`. Public repositories work without a token, at GitHub's low anonymous rate limit.
2. `garnet connectors enable github`. Add `api.github.com` to `web.allowHosts` to read without asking.
3. Optional: `connectors.github.repos` limits it to `owner/name` or `owner/*`; `connectors.github.write: true` adds commenting (each comment is approved with its full text); `apiUrl` points at GitHub Enterprise Server (`https://<host>/api/v3`). It must use https, because the token is sent there; plain http is accepted only for `localhost`, `127.0.0.1` or `[::1]`.

### weather

Current conditions and up to a 7-day forecast from [Open-Meteo](https://open-meteo.com) (keyless; free for non-commercial use). Settings: `connectors.weather.units` (`metric` or `imperial`) and an optional default `location`. The place name you ask about is sent to Open-Meteo's geocoding API.

## The built-in skills

| Skill | Use | Works best with |
| --- | --- | --- |
| `daily-briefing` | A one-minute daily briefing: calendar, weather, reminders, follow-ups | `calendar`, `weather`, `schedule` |
| `web-research` | Answer a question from several web sources, with citations and a confidence note | `web_search`, `web_fetch` |
| `github-triage` | Sort issues, pull requests and notifications into "needs you", "can wait", "can close", with draft replies | `github` |

A skill of the same name in `<home>/skills` takes precedence over a built-in one (`garnet doctor` points this out).

## Why this first set

The goal was a small set that is useful to most people on day one, safe by construction, and needs no new dependencies:

- **Calendar via ICS** covers Google, iCloud, Fastmail, Outlook and Nextcloud with one read-only HTTP GET and no OAuth app. Reading your day is the most common request for a personal agent, and read-only means no injected invitation can make Garnet change your calendar.
- **GitHub** is a well-documented token API, a common daily workflow for Garnet's audience, and the one place where a write (a comment) is both useful and easy to gate: it is a distinct action, off by default, approved with its full text, and limited to listed repositories if you want.
- **Weather** is keyless and gives the daily briefing something to say; it is also the simplest example of the pattern for new connectors.
- **Email is not in this set.** Mail needs IMAP and SMTP, which are not HTTP, so they cannot go through the SSRF-guarded client every connector uses, and the HTTP mail APIs (Gmail, Microsoft Graph) need OAuth apps with refresh tokens. Email is also the largest prompt-injection surface. It is planned with the MCP client and an email connector ([FEATURE-GAPS.md](FEATURE-GAPS.md), items 1.6 and 2.9) rather than squeezed into this one.

Adding a connector is described in `src/connectors/AGENTS.md`.
