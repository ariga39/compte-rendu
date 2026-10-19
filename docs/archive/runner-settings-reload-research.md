# Runner concurrency hot reload: library choice (#161)

> Archived research or implementation history. Its observations and recommendations
> describe the versions and decisions recorded below, not the current product contract.
> Use the [current documentation](../README.md) for supported behavior and operations.

Investigated on 2026-10-16. Scope: one TOML settings file, automatic reload,
validation, and retention of the last valid concurrency setting.

## Decision

Use **smol-toml 1.9.1**, **chokidar 5.0.0**, and the repository's pinned
**Effect 4 Schema**. The libraries parse TOML and observe filesystem changes;
the Runner validates a complete candidate before replacing its effective limit.
No handwritten TOML parser or filesystem watcher is needed.

```toml
concurrency = 3
```

The file takes precedence over `RUNNER_CONCURRENCY`. With no settings file,
the existing environment/default behavior remains. Model, credentials, and
sandbox runtime are startup settings.

## Compared options

| Option                | Provides                                                                                    | Fit for this change                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| smol-toml             | TOML parsing and serialization                                                              | Direct parsing of the explicit data file                                                               |
| chokidar              | File events, atomic-write event normalization, write-stability handling, asynchronous close | Handles editor saves and file replacement                                                              |
| c12                   | Configuration discovery, layered loading, validation, and watching; TOML through confbox    | Useful for applications needing multiple configuration sources; unnecessary discovery and merging here |
| confbox               | Multiple data-format parsers, including TOML using smol-toml                                | Suitable alternative, but only TOML is required                                                        |
| Effect ConfigProvider | Configuration sources and composition                                                       | No TOML parser or file watcher in the installed version; Schema supplies the required validation       |

This is a fit decision, not a claim that c12 cannot handle file replacement.
Its native directory watcher can observe replacements. c12 also supports
executable JS/TS configuration; this Runner only needs an explicitly selected
TOML data file.

## Relevant behavior and limits

- smol-toml documents TOML 1.1 support and its conformance caveats. It parses
  data without executing configuration code. Effect Schema rejects invalid
  concurrency and unexpected properties before application.
- Chokidar 5 requires Node >=20.19.0; production uses Node 24.19.0.
  `watch(path, options)` exposes `add`, `change`, `unlink`, `ready`, and `error`.
  `atomic` coalesces common editor unlink/add sequences;
  `awaitWriteFinish` waits for file-size stability before emitting changes.
  These are event-handling features, not a guarantee that any in-place write
  is transactional. Atomic replacement is the recommended save method.
- Chokidar 5 uses `usePolling` for filesystems that require polling. The Runner
  uses native watching for its local settings file. Do not copy the unreleased
  Chokidar 6 `backend` option into a version 5 configuration.
- The Runner retains the last valid value after read, parse, or validation
  failure. A missing/invalid initial file instead prevents startup.
- Reloading must wake claims when the limit increases, retain already reserved
  jobs when it decreases, and preserve the existing single-flight claim guard.
  Watcher startup and disposal must not lose updates or apply stale reads.

## Primary sources

- [smol-toml: usage, options, conformance caveats](https://github.com/squirrelchat/smol-toml)
- [Chokidar 5.0.0 README and API](https://github.com/paulmillr/chokidar/blob/5.0.0/README.md)
- [c12 configuration loading and watching](https://github.com/unjs/c12)
- [confbox supported parsers](https://github.com/unjs/confbox)
- Installed `effect@4.0.0-rc.111`: `src/ConfigProvider.ts` and `AGENTS.md`.
- npm package metadata checked for `smol-toml@1.9.1`, `chokidar@5.0.0`,
  `confbox@0.3.1`, and `c12@4.0.0-rc.2`; these are the versions considered.
