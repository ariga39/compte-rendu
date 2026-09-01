# OpenCode final Markdown review submission research

## Scope and conclusion

This note is pinned to OpenCode `v1.18.25`, tag commit
[`cb7d8b2f5e44876ef98b661dc10590c915af3a9f`](https://github.com/anomalyco/opencode/tree/cb7d8b2f5e44876ef98b661dc10590c915af3a9f).
It investigates a single question: how can the review agent submit one final
Markdown review without treating its terminal free text as the product, without
a second model/formatter pass, and without returning to a JSON final-response
contract?

The smallest supported boundary is one dedicated OpenCode custom tool,
`submit_review`, whose only model-supplied value is the Markdown string. The
tool validates the publishable envelope and returns a constant acknowledgement.
The Runner accepts only one successfully completed `submit_review` tool call
and uses its retained `state.input.markdown` as the product output. It ignores
all terminal assistant prose as product output while retaining that prose, the
tool call, the tool result, and the rest of the session as raw evidence.

This is deterministic at the **acceptance boundary**, not at model choice: in
1.18.25 there is no supported text-mode setting that forces a particular custom
tool call. If the model never calls the tool, calls it incorrectly, or calls it
more than once, the Job must fail closed. OpenCode's only first-party
single-turn `toolChoice: "required"` final-output path is its JSON-schema
`StructuredOutput` mechanism; it is deliberately not recommended here because
the product decision excludes JSON final responses.

## Why a custom tool fits the boundary

OpenCode officially supports JavaScript or TypeScript custom tools in either
project `.opencode/tools/` or global `~/.config/opencode/tools/`; the filename
becomes the tool name. A tool declares typed arguments, executes trusted code,
and receives the current session, message, directory, and worktree context
([custom-tools documentation](https://opencode.ai/docs/custom-tools/),
[version-pinned documentation](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/web/src/content/docs/custom-tools.mdx#L6-L44),
[context](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/web/src/content/docs/custom-tools.mdx#L137-L156)).
The 1.18.25 registry scans every configured directory for
`{tool,tools}/*.{js,ts}`, imports the modules, and names a default export after
its filename
([source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/tool/registry.ts#L183-L196)).

The submission tool should have one argument, `markdown`, and no caller-chosen
path. Its trusted implementation should:

1. require a non-empty string within the same finite publication bound used by
   the Runner;
2. require the first non-whitespace content to be `## Review:`;
3. return only a small acknowledgement such as `Review submitted.`

The tool input is the exact Markdown product, not an extraction from arbitrary
assistant prose. The schema/implementation does not accept a pathname, so
untrusted PR text cannot redirect any trusted operation. The dependency-free
tool performs no filesystem work; the agent still has no general `edit`
capability.

The skill and prompt should tell the agent to finish all inspection first and
call `submit_review` exactly once with publishable Markdown. That instruction
improves success rate, but it is not the correctness boundary. The Runner must
accept only the completed tool call and reject absence, tool error, duplicates,
size/header failure, or invalid input. Later assistant narration is harmless
because it is evidence only, never the published value.

## Tool calls remain fully observable

OpenCode stores a completed tool part with its tool name, call ID, original
input, string output, metadata, title, and start/end times
([session schema](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/schema/src/v1/session.ts#L277-L325)).
The session processor persists the input and output when a call completes
([source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/processor.ts#L160-L184)).
`opencode run --format json` emits each completed or errored tool part as a
`tool_use` JSONL event and continues emitting step and text events
([source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L678-L690),
[tool/step/text emission](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/cli/cmd/run.ts#L720-L754)).

Therefore this change does not require replacing or filtering the current raw
JSONL/session archive. The archive will contain the `submit_review` Markdown as
the tool input, its acknowledgement as the tool output, all preceding tool
work, and any subsequent free text. `validated-review.md` is a derived copy of
the accepted tool input. The existing JSONL, database/state/log copies, and
session export remain untouched and independently useful for debugging.

## Exact discovery and permission behavior in the isolated workspace

OpenCode derives its global config directory from XDG as
`$XDG_CONFIG_HOME/opencode`
([source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/core/src/global.ts#L10-L27)).
That global directory is always in the resource discovery list; project
`.opencode` directories are omitted when project config is disabled, and an
`OPENCODE_CONFIG_DIR` directory is appended when supplied
([source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/config/paths.ts#L23-L40)).
The public config documentation also identifies plural `tools/`, `skills/`,
and `plugins/` directories and documents both global XDG config and custom
config-directory discovery
([config documentation](https://opencode.ai/docs/config/),
[version-pinned locations](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/web/src/content/docs/config.mdx#L42-L59)).

For the current Runner layout, the minimal isolated workspace is:

```text
<configRoot>/
└── opencode/
    ├── skills/
    │   └── pr-review/
    │       └── SKILL.md          # already present; submission instruction changes
    └── tools/
        └── submit_review.js      # new, one default-exported custom tool
```

No local plugin file and no additional `opencode.json` are required. The
existing `OPENCODE_CONFIG_CONTENT` can keep the review agent's permissions and
must add the exact `submit_review: "allow"` rule after the catch-all deny.
OpenCode removes tools with a final matching deny from the model request, so
the explicit allow is necessary under the current `"*": "deny"` review-agent
policy
([permission documentation](https://opencode.ai/docs/permissions/),
[tool filtering source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/llm/request.ts#L208-L214)).
All existing read-only Git/GitHub/read/search permissions can remain as they
are.

### Package dependency choice for 1.18.25

The documented, typed authoring style imports `tool` from
`@opencode-ai/plugin`; external dependencies normally use a config-directory
`package.json`, and OpenCode runs `bun install` at startup
([custom-tool helper](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/web/src/content/docs/custom-tools.mdx#L25-L44),
[dependency documentation](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/web/src/content/docs/plugins.mdx#L74-L99)).
OpenCode 1.18.25 also attempts to add its matching
`@opencode-ai/plugin` version to discovered config directories in the
background
([source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/config/config.ts#L438-L471)).

The review Sandbox intentionally has no npm-registry access and must not
install dependencies during review. For this exact pinned release, the
smallest no-network tool can therefore be a dependency-free JavaScript default
export with plain JSON-Schema argument entries and explicit runtime validation.
The 1.18.25 registry recognizes any object with `args`, `description`, and
`execute`, and has a compatibility path that converts non-Zod argument entries
to JSON Schema
([recognition and compatibility source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/tool/registry.ts#L351-L371)).
That needs no checked-in `package.json` or imported package. It is an exact
1.18.25 compatibility fact, not a promise for a future OpenCode version; any
image upgrade must revalidate it. If the project later prefers the documented
typed helper, vendor the matching package into the prebuilt Sandbox image
rather than opening npm access during a review.

## Why the alternatives are weaker

### A plugin-provided tool

A plugin can expose a tool with the same description/argument/execute shape
([plugin documentation](https://opencode.ai/docs/plugins/),
[version-pinned example](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/web/src/content/docs/plugins.mdx#L278-L313)).
It would work, but it adds a plugin module and initialization layer without
adding anything needed by this one submission operation. A standalone custom
tool is smaller and has the same session/tool evidence.

### `tool.execute.before` / `tool.execute.after`

These hooks receive the tool name, session/call IDs, arguments, and completed
output
([public hook types](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/plugin/src/index.ts#L266-L281)).
They are awaited sequentially when an existing tool executes
([execution source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/tools.ts#L92-L129)).
They can audit or modify a call, but cannot cause the model to make the
submission call. Handling the submission inside the custom tool is simpler than
a second plugin whose after-hook watches that tool.

### Generic events and `session.idle`

Plugins can subscribe to `message.part.updated`, `session.idle`, and other
events, but the v1 event hook invocation is fire-and-forget (`void`) rather
than awaited
([event list](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/web/src/content/docs/plugins.mdx#L142-L202),
[dispatch source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/plugin/index.ts#L255-L262)).
An idle handler that later reads the last message would both race process exit
and return to extracting arbitrary assistant prose. It is not a publication
boundary.

### `experimental.text.complete`

This awaited hook can rewrite every completed text part before it is persisted
([hook type](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/plugin/src/index.ts#L327-L330),
[execution source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/processor.ts#L512-L531)).
Using it to strip a preamble, find a heading, or rewrite the response would be
the prohibited arbitrary-prose extraction path and would also alter raw
session evidence. It should not be used.

### Built-in structured output

OpenCode's internal structured-output path creates a `StructuredOutput` tool,
sets `toolChoice: "required"`, captures the validated call, and ends the loop
after success
([source](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/prompt.ts#L1225-L1293),
[tool implementation](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/opencode/src/session/prompt.ts#L1564-L1590)).
That is the only inspected 1.18.25 path that truly forces a final tool call in
one turn, but it explicitly requires a JSON-schema output format and JSON input.
It would restore the structured JSON contract the product has rejected, so it
is not the recommended solution.

No public custom-tool or plugin hook in 1.18.25 exposes that internal final-tool
callback or its `toolChoice` control. The public `chat.params` hook can change
sampling limits/provider options, not the request's top-level `toolChoice`
([hook type](https://github.com/anomalyco/opencode/blob/cb7d8b2f5e44876ef98b661dc10590c915af3a9f/packages/plugin/src/index.ts#L244-L256)).
Consequently the correct non-JSON behavior is fail closed when
`submit_review` is absent, not add a correction turn or pretend that prompt
wording can guarantee the call.

## Recommended acceptance contract

The next implementation slice should keep the contract deliberately small:

- exactly one completed `submit_review` tool part for the primary review
  session;
- tool input `markdown` is the accepted product value;
- finite non-empty Markdown whose first non-whitespace content is
  `## Review:`;
- no extraction, stripping, templating, semantic rewrite, JSON final response,
  retry turn, or second model;
- all free text and all tool events remain byte-exact in the current evidence
  archive; and
- missing/errored/duplicate/invalid submission fails as `invalid-output`,
  followed by the existing evidence finalization and Sandbox cleanup.

This removes the specific source of issue #109—the product depending on the
shape of the model's terminal prose—while preserving the useful Markdown
review and the complete debuggable session.
