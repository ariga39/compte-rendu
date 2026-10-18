# OpenCode 1 vs 2: auth and Runner-compatibility research

Research date: 2026-10-18. Bounded primary-source inspection of the official
install channels, release metadata, published docs, and the tagged source of the
pinned release and of verified v2 release 2.0.32. No credential, private key, repository content, or raw session is included in this
note. Isolated synthetic session exports were inspected; live probes used existing
host-side credential resolvers without copying resolved keys into the Sandbox.

The user requests a V2 adaptation. This note records verified facts and required
prerequisites; the implementation follows the combined [review decision design](review-decisions-design.md).

## Channels and versions (verified today)

| Surface                          | Verified value                                                                   | Source                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://opencode.ai/install`    | installs OpenCode **1**; refuses a requested `>= 2.0.0`, points to `/v2/install` | [v1 installer](https://opencode.ai/install)                                                                                                                                              |
| `https://opencode.ai/v2/install` | installs OpenCode **2**                                                          | [v2 installer](https://opencode.ai/v2/install)                                                                                                                                           |
| v1 latest                        | `v1.19.3` (commit `60c9be092129745688bb3c3a752affc6cbd66ede`)                    | [release](https://github.com/anomalyco/opencode/releases/tag/v1.19.3), [`opencode-ai`](https://registry.npmjs.org/opencode-ai)                                                           |
| v2 latest                        | `v2.0.32`                                                                        | [tag](https://github.com/anomalyco/opencode/releases/tag/v2.0.32), [`@opencode/cli`](https://registry.npmjs.org/@opencode/cli), [pointer](https://opencode.ai/update/api/latest/cli/npm) |

The v1 installer avoids GitHub's "Latest" release because it may be OpenCode 2;
it resolves from the `opencode-ai` npm tag and the newest `v1.*` GitHub entry.
Observed `releases/latest` = `v1.19.3` today, but "latest" is not inherently
v1-only — that is only what it returned at this observation. The v2 installer
installs a scoped npm target package (`@opencode/cli-<os>-<arch>`) as `opencode`.
So "OpenCode default is 2" is channel-dependent: bare `/install` installs 1; the
official v2 installer installs 2.

## v1 auth (pinned 1.18.25)

- `auth.json` at `Global.Path.data/auth.json` (docs `~/.local/share/opencode/auth.json`);
  `OPENCODE_AUTH_CONTENT` is a real **undocumented** var that `Auth.all()` parses
  first, before `auth.json`
  ([source](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/opencode/src/auth/index.ts)).
- `OPENCODE_CONFIG_CONTENT` is the documented inline-config var (already used);
  `OPENCODE_API_KEY` is read by the v1 `opencode` provider plugin
  ([source](https://github.com/anomalyco/opencode/blob/v1.18.25/packages/core/src/plugin/provider/opencode.ts)),
  the deployment's credential name, not a documented generic variable.
- Provider options are `provider.<id>.options.{apiKey,baseURL}` in
  `OPENCODE_CONFIG_CONTENT`; the pre-upgrade Runner emitted
  `provider: { "opencode-go": { options: { baseURL }, models } }` and no `apiKey`
  .
- Auth, provider-auth, tool-registry, config, and export source files are
  byte-identical 1.18.25→1.19.3; only `run.ts` session-sharing was removed.

## v2 auth (verified against 2.0.32)

Docs ([`/v2/docs/cli/providers`](https://opencode.ai/v2/docs/cli/providers)):

- Saved API keys and OAuth tokens live in the server's SQLite database
  (`~/.local/share/opencode/opencode.db` by default; `XDG_DATA_HOME`, channel,
  and `OPENCODE_DB` displace it). Credentials are managed by `/connect` or the
  auth commands, not by editing the database.
- v2 imports supported credentials from the legacy `auth.json` **once** during
  its database migration; new/updated credentials go only to SQLite.
- Env credentials are read from the **server process that runs model requests**
  (standalone mode, or `opencode service set env`). **A saved account takes
  precedence over an environment connection** for the same integration.

Source (2.0.32): legacy import reads `path.join(global.data, "auth.json")`
([migration](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/database/migration/20260805200742_import_legacy_credentials.ts));
SQLite credential service, no file write-back
([credential.ts](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/credential.ts));
`auth export`/`auth import` move a JSON array of `Credential.Entry`
([commands](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/cli/src/commands/commands.ts));
the v2 `opencode` plugin still reads `process.env.OPENCODE_API_KEY`
([source](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/plugin/provider/opencode.ts));
native config uses `providers.<id>.settings.{apiKey,baseURL}` and `package`
([schema](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/schema/src/config/provider.ts)),
with v1 `provider.<id>.options` kept as an in-memory normalizer.

Binary inspection (read-only `strings` on the verified 2.0.32 binary):
`OPENCODE_API_KEY`, `OPENCODE_CONFIG_CONTENT`, and `OPENCODE_DB` are present;
`OPENCODE_AUTH_CONTENT` was **not found**. This is recorded as "not found"; it
does not prove the variable was removed, and the plan does not rely on it.

Decisive proof, server-bound env credential under `--standalone`: isolated
2.0.32 run (`HOME` isolated; custom provider `env: [PROBE_MODEL_KEY]`,
**no** `settings.apiKey`; `--standalone`; `PROBE_MODEL_KEY` =
`nonsecret-env-fixture`) against a local model server asserting
`Authorization: Bearer nonsecret-env-fixture`. Result: PASS — two requests,
`PONG`, exit 0, no saved account, no auth import. This initial probe covered environment authentication. The later sbx probes
below also verified the credential proxy path.

## Custom tools and `submit_review`

v1: the Runner writes `submit_review.js` under `<configRoot>/opencode/tools/` and
reads the single completed `submit_review` call from the JSONL stream.

v2: custom tools are plugins registered via
`ctx.tool.transform(editor => editor.add({ name, description, input, ... }))`
inside `Plugin.define({ id, setup(ctx) })`, discovered from `.opencode/plugins/`
(global: the config directory's `plugins/`). The v1→v2 guide states V1 plugin
implementations do not run in V2
([migration](https://opencode.ai/v2/docs/build/plugins/migrate-v1)).

Observed on the isolated 2.0.32 binary: the existing v1-style `submit_review.js`
was **not** in the model tools catalog. The cause is not asserted without a
tagged source line.

## Run output (JSONL) and session export

v1 CLI used by the Runner: `opencode run ...` (JSONL evidence), top-level
`opencode export <sessionID>`, `opencode session list --format json`. v2 (2.0.32):
`opencode run --format json` emits lines
`{ "type", "timestamp", "sessionID", ...data }`
([source](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/cli/src/run/noninteractive.ts));
top-level `export` is gone and moved to `opencode session export <sessionID>`
([commands](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/cli/src/commands/commands.ts),
[handler](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/cli/src/commands/handlers/session/export.ts)).

Isolated reproduction (real, no secrets): v2 run against a local
OpenAI-compatible fake server with isolated `HOME`/`PATH` gave exit 0 and `PONG`,
but the JSONL contained **only a `text` event, no `step_finish`**. The export for
the same session contained `info` (`outcome: "succeeded"`, model, tokens, time,
location) and `messages` (user; assistant with `content` and `finish`/`rawFinish`
= `"stop"`; idle with `outcome: "succeeded"`). The pre-upgrade Runner required a terminal `step_finish`/`step-finish` signal,
which this run did not emit. The implemented V2 gate instead requires matching
export `info.id`, `info.outcome: succeeded`, a final assistant `finish: stop`, and
a final idle message with `outcome: succeeded`. Scripted completion/failure
fixtures and the live successful probes exercise this contract.

## Evidence security

The Runner archives `XDG_DATA_HOME` into the evidence tree and strips only
`auth.json` and symlinks. Under v2 credentials
live in `XDG_DATA_HOME/opencode/opencode.db`, so archiving that tree copies the
credential database. Preserve byte-exact evidence by starting v2 with a **fresh,
placeholder-only database and never importing a legacy `auth.json`**, so the
archived DB holds no resolved credential. Do not rely on separately sanitizing or
dropping the DB; that breaks byte-exact evidence.

## Facts vs unknowns

Facts: (1) v1 and v2 are separate channels; (2) `/install` installs 1 and refuses
2, `/v2/install` installs 2, and observed `releases/latest` = `v1.19.3` today is
not inherently v1-only; (3) v1 auth is file/env based and the Runner's v1 surfaces
are unchanged 1.18.25→1.19.3; (4) v2 auth is SQLite-based, imports legacy
`auth.json` once, gives saved accounts precedence over env, reads env credentials
from the server process, and server-bound env under `--standalone` is proven on
2.0.32; (5) `OPENCODE_API_KEY`, `OPENCODE_CONFIG_CONTENT`, `OPENCODE_DB` are
present in the 2.0.32 binary and `OPENCODE_AUTH_CONTENT` was not found; (6) v2
custom tools are plugins via `ctx.tool.transform`, v1 plugin implementations do
not run in v2, and the v1-style `submit_review.js` was absent from the observed
v2 tools catalog (cause unverified); (7) v2 moved `export` under `session` and the
observed v2 run emitted no `step_finish`.
Unused compatibility questions: whether a bare
`<config>/opencode/tools/*.js` file is still discovered in v2; whether
`OPENCODE_AUTH_CONTENT` is intentionally dropped or relocated.
The integration uses the native plugin API and does not depend on those legacy
surfaces. Normal-completion and proxy-placeholder checks are recorded below.

## V2 adaptation: prerequisites and acceptance

Target is verified 2.0.32. Each item is a separate, testable slice through the
existing Runner/Core seams in `docs/design.md`, runtime code in Effect 4.

1. **Auth.** Keep the credential an opaque placeholder. Start v2 with
   `--standalone`, the credential on the server process, a fresh DB, and no
   import, so no saved account can take precedence. Confirm the placeholder
   reaches the gated model host (verified by the sbx probes below).
2. **Custom tool.** Re-register `submit_review` as a v2 plugin under the config
   directory's `plugins/`, using the single-tool `decision` + `markdown`
   contract and the last-match permission rule.
3. **Normal completion.** Replace the `step_finish`-only check with a
   normal-completion signal whose semantics are confirmed by test against the
   exported session, still requiring exactly one completed `submit_review` part.
4. **Session archive.** Switch to `opencode session export <sessionID>` and
   validate the v2 `info`/`messages` shape.
5. **Evidence security.** Fresh placeholder-only DB, no legacy import; keep
   failing closed and evidence byte-exact.
6. **Images.** Produce a digest-pinned OpenCode 2 image (pin `@opencode/cli*`;
   verify `opencode --version`), update both Dockerfiles, and publish the explicit
   validated decision with its Markdown review.

Acceptance (observable behavior): a v2 run authenticates through the placeholder
with no saved account and no resolved credential in evidence; completes only on a
tested authoritative normal-completion signal plus exactly one `submit_review`;
archives a valid v2 session export; and publishes the explicit decision with exact validated Markdown.

## Implementation probes (2026-10-18)

The real 2.0.32 binary now successfully registers and executes the V2 result
plugin. Invalid enum arguments and executor validation errors reach the next
model turn; a valid submission completes in the same session. See
[output reliability](review-output-reliability-research.md).

A real sbx probe using a synthetic repository and the existing credential proxy
successfully read its README, submitted a structured decision, exported the
successful session and destroyed its scoped resources. No real key was copied
into the Sandbox. Native `agents.review.permissions` with `shell` is verified.
Both checked-in image Dockerfiles build and verify `opencode v2.0.32` (the CLI's
version output includes that prefix).

The custom endpoint probe exposed a concrete override requirement: setting only
`providers[provider].settings.baseURL` did not replace an existing catalog model's
own URL. Setting `providers[provider].models[model].settings.baseURL` as well did.
The Runner uses the bundled `@opencode/ai/providers/openai-compatible` package for
custom endpoints, with the key remaining an environment placeholder. No runtime
package installation is needed. This was verified first against a scripted local
endpoint, then against a real model through sbx's credential proxy.

Both configured routes passed independent real sbx probes: a custom
OpenAI-compatible endpoint and the official OpenCode Go endpoint. Each produced
one completed `approve` submission and a matching successful session export;
checks found no resolved credential bytes in JSONL or export, and scoped cleanup
completed. The official route required an explicit model definition because the
pinned binary catalog lacked that model. These probes used the V2 binary in the
existing Sandbox template; both new images built separately. Full candidate
Runner-to-GitHub publication is a separate rollout acceptance check.
