# secrets

The optional encrypted secret store at `<RUBY_HOME>/secrets`, and how secret names resolve.

- Public API: `SecretStore` (`exists`, `get`, `names`, `set`, `setMany`, `remove`), `openSecretStore(home, env)`, `secretLookup(env, store)`, `unlockFrom(env)`, `unlockWarnings`, `seal`/`unseal` (the file format), `writePrivateFile`, `validSecretName`, `PASSPHRASE_ENV`, `KEY_FILE_ENV`.
- Resolution (`secretLookup`): a non-empty process environment variable wins, then the store. The store is decrypted only when a name is missing from the environment and the file exists, so env-file-only setups never need a passphrase. Values are never copied into `process.env` (child processes do not inherit them).
- Unlock: `RUBY_SECRETS_KEY_FILE` (path to a file, mode 0600 or stricter, trimmed contents are the key material) or `RUBY_SECRETS_PASSPHRASE`; setting both is an error. Writes need at least 12 characters (`ruby secrets keygen` makes a 32-byte key file). Warn when the passphrase sits in `<home>/env` or the key file inside `<home>`: that defeats encryption at rest and ends up in backups.
- Format (version 1, JSON): `{format: "ruby-secrets", version, kdf: {name: "scrypt", N, r, p, salt}, cipher: "aes-256-gcm", nonce, tag, data}`; base64 fields. Key = scrypt(material, 16-byte salt, 32 bytes; default N=2^15, r=8, p=1). The header (everything but `tag` and `data`) is the GCM additional data, so edited KDF parameters, salt or nonce fail authentication. Plaintext is `{"secrets": {NAME: value}}`; names are encrypted too. Every write uses a fresh salt and nonce. Reads bound the KDF parameters (N ≤ 2^20, r ≤ 16, p ≤ 4).
- Writes are atomic: a `wx` temp file with mode 0600, fsync, rename, chmod 0600, best-effort directory fsync.
- Errors are `config` RubyErrors: locked (names both unlock variables), wrong key or modified file (GCM cannot tell them apart, so the message says both), foreign or newer format. Messages never contain key material or values.
- Format change checklist: bump `SECRETS_VERSION`, keep reading the old version, add a test.
- Must not: log, print or return values except through `get`; read config (the composition root and CLI pass names); keep the key material anywhere but memory.
- Not done: OS keychain unlock, key rotation (`rm` + re-`set` works; there is no `rekey`), locking against two concurrent writers (last write wins). A running service reads the store once; restart it after changes.
