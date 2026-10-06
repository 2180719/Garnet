# Configuration and the environment

Rule: every setting that is not a secret lives in `<GARNET_HOME>/config.json`. The environment holds secrets and a few bootstrap values that must exist before the config can be read. Nothing else.

## Changing settings

| Command | What it does |
| --- | --- |
| `garnet config explain` | Every setting, with its type, default and description. |
| `garnet config show` | The effective config, secrets redacted. |
| `garnet config get <path>` | One setting, for example `garnet config get model.name`. |
| `garnet config set <path> <value>` | Validate with the schema, write `config.json` atomically (temp file, then rename), print `path: old -> new`. Values are JSON when they parse (`true`, `42`, `["a","b"]`, `'{"k":1}'`), otherwise text. Restart Garnet for it to take effect. |
| `garnet config unset <path>` | Return a setting to its default (or remove an optional one). |
| `garnet config check` | Validate the file. |

Array items are addressed by index (`jobs.0.enabled`). An unknown path, an invalid value or a value that fails any cross-field rule is refused with every problem listed, and the file is left as it was.

Secrets never go through these commands. Fields that end in `Env` (`model.apiKeyEnv`, `channels.telegram.tokenEnv`, `media.transcription.apiKeyEnv`, ...) hold the NAME of an environment variable or stored secret. `config set` refuses a value there that is not a plain variable name, and refuses any value anywhere that looks like a credential (provider keys, bot tokens, bearer tokens), without printing it. Store the value with `garnet secrets set <NAME>` (stdin, never argv) or as a line in `<home>/env`.

`garnet setup` follows the same split: choices go to `config.json`; keys go to the encrypted store or `<home>/env` (mode 600); the only non-secret line it writes to `<home>/env` is `GARNET_SECRETS_KEY_FILE`, the path of the store's key file, which is needed before the store can be opened.

## Precedence

1. `GARNET_HOME` (environment) decides which directory is read. This is the one value that cannot live in config.
2. Inside that directory, `config.json` decides every setting. There are no environment overrides of config fields, so nothing in the environment can shadow a setting. `garnet doctor` warns about any `GARNET_*` variable that is set but that Garnet does not read, so a setting someone tried to put in the environment is not silently ignored.
3. Secrets: a non-empty process environment variable (including lines loaded from `<home>/env`) wins over the encrypted store. `garnet secrets list` and `garnet doctor` say when the environment overrides a stored name.

The legacy `RUBY_*` twins of `GARNET_HOME`, `GARNET_SECRETS_KEY_FILE`, `GARNET_SECRETS_PASSPHRASE`, `GARNET_NODE`, `GARNET_COMMAND_NAME` and the installer variables are still read when the `GARNET_*` one is unset; `garnet doctor` reports them as deprecated.

## Every environment variable Garnet reads

Classes: **secret** (stays in the environment, `<home>/env` or the encrypted store), **bootstrap** (needed before config loads, or by the shim, so it cannot be a config field), **system** (standard OS or terminal variables Garnet only honors), **install** (read by `install.sh` only), **test** (never read in production). No variable is a non-secret setting that still needs moving: the audit found none that was env-only (grep of `process.env`, `env[...]`, `deps.env`, `envVar(`, `GARNET_*`, `RUBY_*` across `src/`, `install.sh`, `dashboard/`, `scripts/` and the service units).

| Variable | Class | Read by | Notes |
| --- | --- | --- | --- |
| `GARNET_HOME` (legacy `RUBY_HOME`) | bootstrap | `config/load.ts` `garnetHome`, the service unit (`Environment=`), the launchd wrapper | Data directory; default `~/.garnet`. The config file is always `<GARNET_HOME>/config.json` (there is no separate config-path variable). |
| `GARNET_SECRETS_KEY_FILE` (legacy `RUBY_...`) | bootstrap | `secrets/unlock.ts` | Path (not secret) of the key file that unlocks the encrypted store. Needed before the store opens, so it cannot come from the store; `setup` writes it to `<home>/env`. |
| `GARNET_SECRETS_PASSPHRASE` (legacy `RUBY_...`) | secret | `secrets/unlock.ts` | Passphrase alternative to the key file. |
| `GARNET_NODE` (legacy `RUBY_NODE`) | bootstrap | the `garnet` shim written by `install.sh` | Which `node` the shim runs. Read by a shell script before any Garnet code. |
| `GARNET_COMMAND_NAME` | bootstrap | set by the shim; read by `doctor` | Name of the installed command (`install.sh --name`), so doctor checks the right PATH entry. Not user-set. |
| `GARNET_INSTALL_DIR`, `GARNET_BIN_DIR`, `GARNET_BIN_NAME`, `GARNET_REPO`, `GARNET_REF` (legacy `RUBY_...`) | install | `install.sh` | Installer inputs, equal to its flags. Not read by the running service. |
| `GARNET_LIVE_TESTS` | test | tests | Opt-in live provider tests. |
| `ANTHROPIC_API_KEY` | secret | `model.apiKeyEnv` default | The name is configurable (`model.apiKeyEnv`). |
| `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, any other provider key | secret | `model.apiKeyEnv` | Whatever name config points at. |
| `TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN` | secret | `channels.telegram.tokenEnv`, `channels.discord.tokenEnv` | Names configurable. |
| `BRAVE_API_KEY`, `TAVILY_API_KEY` | secret | `web.search.apiKeyEnv` | Name configurable. |
| Any name in `media.transcription.apiKeyEnv` | secret | media | Name configurable. |
| `PATH` | system | doctor, sandbox, media command lookup, migrate | Passed to local sandbox and media child processes; never settings. |
| `HOME`, `LANG`, `LC_ALL`, `TMPDIR` | system | local sandbox, media commands | Forwarded to child processes in a fixed, minimal environment. |
| `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`, `XDG_RUNTIME_DIR` | system | `sandbox/docker.ts` | Forwarded to the docker client only, so it can reach its daemon. The container never sees them. Sandbox choices (image, network, memory) are config under `sandbox.*`. |
| `XDG_CONFIG_HOME` | system | `garnet setup` | Default location offered for a new key file (`$XDG_CONFIG_HOME/garnet/secrets.key`). |
| `VISUAL`, `EDITOR` | system | `garnet memory edit` | The owner's editor, as in any CLI. |
| `TERM`, `COLORTERM`, `NO_COLOR` | system | terminal chat, setup | Terminal capability and the `NO_COLOR` convention. |
| `HERMES_HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_PROFILE`, `OPENCLAW_WORKSPACE_DIR` | system | `garnet import` | Where the other harness keeps its files, used only to find an import source; `garnet import --from <dir>` overrides. Not Garnet settings. |

## Adding a setting

Put it in `src/config/schema.ts` with a `.describe()` (a test fails for any setting without one, so `garnet config explain` always covers it), bump `CONFIG_VERSION` and add a migration if the change is incompatible, and add it to `PROTECTED_CONFIG_PATHS` if it chooses a host command, a network destination or who may reach Garnet. Do not read a setting from `process.env`. If a value is a secret, add an `...Env` field naming it and resolve it with `garnet.secret(name)`.
