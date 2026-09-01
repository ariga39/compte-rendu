# OpenCode final review output for issue #105

Research date: 2026-09-01. Scope: official OpenCode documentation and the
official `anomalyco/opencode` v1.18.25 tag, pinned to commit
`cb7d8b2f5e44876ef98b661dc10590c915af3a9f`.

## Decision

Do not require a structured `ReviewResult`. Let the review agent finish with
human-readable Markdown and publish that Markdown as the GitHub COMMENT review
body.

Keep `opencode run --format json` for the current Docker Sandbox Runner. After
a successful process with no OpenCode error event:

1. Find the terminal assistant message from the last completed `step_finish`
   event. Its `part.messageID` identifies the assistant message; a normal
   terminal reason is not `tool-calls` or `unknown`.
2. In original event order, take every completed `text` event whose
   `part.messageID` matches that terminal message. Ignore synthetic or ignored
   parts, trim only the outer whitespace, and join multiple parts with a
   newline.
3. Require one non-empty, size-bounded Markdown body. Publish the selected text
   directly, preserving its content including outer whitespace; use trimming
   only to determine whether it is empty.
   Empty output, malformed JSONL, OpenCode error events, process failure, and
   timeout remain failures.

Do not take only the last `text` event. OpenCode emits an event for every
completed text part, and a tool-using run can contain multiple assistant
messages and multiple text parts. Text events have no `final` flag. The
`step_finish` and text parts both carry `messageID`, which is the existing
JSONL seam needed to select all text belonging to the terminal assistant
message.

Do not switch to default CLI formatting. In default mode, completed tool parts
are rendered to stdout before assistant text; non-TTY assistant text is also
written to that same stdout. It is a human transcript, not a pure final-answer
channel.

Sources:

- [OpenCode CLI: `run` and its continuation flags](https://opencode.ai/docs/cli/#run)
- [OpenCode v1.18.25 CLI flags](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L147-L179)
- [OpenCode v1.18.25 JSON events include `sessionID`](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L670-L690)
- [OpenCode v1.18.25 emits every completed tool, step, and text part](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L720-L764)
- [OpenCode v1.18.25 text-part fields have no final marker](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/schema/src/v1/session.ts#L102-L116)
- [OpenCode v1.18.25 terminal-finish decision](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/prompt.ts#L1295-L1319)
- [OpenCode v1.18.25 default mode writes tool summaries and text to the same output](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L724-L763)

## Exact message APIs

The semantically strongest interface is not stdout. The official session API
supports:

- `POST /session/:id/message`, which sends one prompt, waits, and returns the
  resulting assistant `{ info, parts }`;
- `GET /session/:id/message`, which lists the session's messages with their
  parts; and
- `GET /session/:id/message/:messageID`, which reads one exact message.

OpenCode's own prompt loop returns the newest assistant message after the run.
The v2 SDK exposes that through `client.session.prompt`. The current CLI already
receives this exact response but uses it only to check `result.error`; it does
not emit the returned `{ info, parts }` as a dedicated JSON record. Moving the
Runner to the SDK/server API would therefore be the cleanest future interface,
but it is more work than grouping the current JSONL by the terminal
`messageID`.

`opencode export SESSION_ID` is an official read-after-run fallback. It writes
the session plus every message and part as JSON. It can recover the newest
assistant message, but it exports much more data and adds another process and
parse step; the Runner already has enough identity in its live JSONL, so export
should remain evidence rather than the product-output path.

Sources:

- [OpenCode server message APIs](https://opencode.ai/docs/server/#messages)
- [OpenCode v1.18.25 v2 SDK `session.prompt`](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/sdk/js/src/v2/gen/sdk.gen.ts#L3737-L3790)
- [OpenCode v1.18.25 prompt loop returns the newest assistant](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/prompt.ts#L1334-L1346)
- [OpenCode v1.18.25 CLI receives but does not emit the prompt response object](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L863-L876)
- [OpenCode CLI session export](https://opencode.ai/docs/cli/#export)
- [OpenCode v1.18.25 export reads all messages and writes JSON](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/export.ts#L281-L291)

## Alternative not selected: one same-session corrective turn

If a future contract again requires structured output, the smallest current
CLI fallback is one explicit follow-up in the same session:

```console
opencode run \
  --session SESSION_ID \
  --format json \
  --model opencode-go/deepseek-v4-flash \
  'Reformat the review you already completed. Do not redo the review or call tools. Return exactly one JSON object matching the required schema, with no prose or Markdown fence.'
```

This is an official continuation path: `--session` loads and continues that
session, while `--fork` is a separate opt-in. Every JSONL event already carries
the top-level session ID. This fallback is unnecessary for the selected
Markdown result and should not be added to the current product path.

Sources:

- [OpenCode v1.18.25 loads the requested session without forking](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L456-L489)
- [OpenCode v1.18.25 sends a follow-up prompt to that session](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L863-L876)

## Alternative not selected: plugin correction

OpenCode v1.18.25 exposes these relevant official plugin surfaces:

- `experimental.text.complete(input, output)` receives
  `{ sessionID, messageID, partID }` and mutable `{ text }`. OpenCode awaits the
  hook and replaces that completed text part before persisting it. It can strip
  a fence or otherwise transform one part, but it is not a whole-assistant
  completion hook: a tool-using assistant may have multiple text parts. It has
  no retry/result channel.
- `event({ event })` can observe `session.idle`, `message.updated`, and
  `message.part.updated`. A plugin closure also receives the official SDK
  client, so custom code could query the session and attempt another prompt.
  However, OpenCode invokes event callbacks with `void` and does not await
  them. At the same boundary, `opencode run` stops consuming events when the
  session becomes idle. An idle-event retry can therefore race CLI shutdown;
  it is not an official atomic “validate then retry” facility.
- `chat.message(input, output)` can transform a new user message and its parts
  before it is saved. It runs before the response, not after a completed
  assistant result, and its v1.18.25 public plugin type does not expose a
  structured-result retry operation.

Therefore a plugin may normalize text in place, or independently orchestrate
SDK calls, but there is no official completed-message hook that both validates
the full assistant result and requests one awaited follow-up turn. The selected
Markdown path needs neither normalization nor a plugin.

Sources:

- [OpenCode v1.18.25 hook signatures](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/plugin/src/index.ts#L222-L243)
- [OpenCode v1.18.25 plugin context includes the SDK client](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/plugin/src/index.ts#L56-L63)
- [OpenCode v1.18.25 `experimental.text.complete` signature](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/plugin/src/index.ts#L327-L330)
- [OpenCode v1.18.25 applies the hook to each `text-end`](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/processor.ts#L512-L531)
- [OpenCode plugin event list and `session.idle` example](https://opencode.ai/docs/plugins/#events)
- [OpenCode v1.18.25 fires event hooks without awaiting them](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/plugin/index.ts#L255-L263)
- [OpenCode v1.18.25 CLI exits its event loop at idle](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L793-L799)

## Alternative not selected: native structured output

OpenCode v1.18.25 has native JSON Schema output through the v2 SDK/session HTTP
API. A prompt can carry:

```ts
format: {
  type: "json_schema",
  schema: reviewRunOutputJsonSchema,
  retryCount: 0,
}
```

OpenCode adds a `StructuredOutput` tool whose input is the supplied JSON
Schema, instructs the model to use it only after completing research and other
tool calls, validates the tool arguments, and returns the captured object as
`AssistantMessage.structured`. This directly prevents prose/fence framing and
is cleaner than parsing assistant text.

It is not available through the current CLI invocation. In v1.18.25,
`opencode run --format` accepts only `default` or `json`, where `json` means raw
event JSONL; the CLI does not accept a schema or forward a `format` object to
`session.prompt`. Using native structured output would require calling the v2
SDK/server API and reading `info.structured` (or adding a separate typed bridge),
which is a larger Runner change than one CLI continuation.

The documented `retryCount` must not be relied on in v1.18.25. Its schema
defaults the field to 2, but the runtime never reads it to schedule a corrective
turn; when a completed response omits `StructuredOutput`, the source records a
`StructuredOutputError` with `retries: 0`. Native schema validation is useful,
but it does not implement the requested bounded retry in this pinned release.
None of this is required when the product publishes the final Markdown text.

Sources:

- [OpenCode SDK: structured output](https://opencode.ai/docs/sdk/#structured-output)
- [OpenCode v1.18.25 v2 SDK prompt accepts `format`](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/sdk/js/src/v2/gen/sdk.gen.ts#L3737-L3788)
- [OpenCode v1.18.25 JSON Schema output type](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/sdk/js/src/v2/gen/types.gen.ts#L223-L237)
- [OpenCode v1.18.25 `AssistantMessage.structured`](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/sdk/js/src/v2/gen/types.gen.ts#L333-L372)
- [OpenCode v1.18.25 installs and requires `StructuredOutput`](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/prompt.ts#L1243-L1292)
- [OpenCode v1.18.25 validates the structured tool arguments](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/prompt.ts#L1564-L1590)
- [OpenCode v1.18.25 `retryCount` schema default](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/schema/src/v1/session.ts#L65-L79)
- [OpenCode v1.18.25 missing-output behavior uses `retries: 0`](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/prompt.ts#L1295-L1316)
- [OpenCode v1.18.25 CLI `--format` is event formatting only](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L174-L179)
