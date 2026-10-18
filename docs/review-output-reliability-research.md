# Review output reliability: structured-output best practice

Research date: 2026-10-18. Bounded primary-source review of how agent libraries
produce a final, machine-checkable result, to choose a pattern before relying on
the OpenCode `submit_review` result tool. Scope: LangChain structured output,
Pydantic AI output modes/retries, AI SDK structured data, and DeepSeek's served
capabilities. The initial research made no code changes. OpenCode-specific verification and
the implementation choice are recorded below.

Sources (direct):

- LangChain structured output: <https://docs.langchain.com/oss/python/langchain/structured-output>
- Pydantic AI output: <https://pydantic.dev/docs/ai/core-concepts/output/>
- AI SDK structured data: <https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data>
- DeepSeek JSON Output: <https://api-docs.deepseek.com/guides/json_mode>
- DeepSeek Tool Calls: <https://api-docs.deepseek.com/guides/tool_calls>

## The three strategies

| Strategy               | LangChain           | Pydantic AI                  | Mechanism                                                    | Strength                              |
| ---------------------- | ------------------- | ---------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| Provider-native schema | `ProviderStrategy`  | `NativeOutput`               | Provider API enforces a JSON schema                          | "Most reliable method when available" |
| Final-result tool      | `ToolStrategy`      | `ToolOutput` (default)       | Schema becomes a tool's parameter schema; the model calls it | Supported by virtually all models     |
| Prompted JSON          | (no dedicated type) | `PromptedOutput` / JSON mode | Schema injected as text; response parsed                     | "Often the least reliable"            |

- LangChain: `type[Schema]` auto-selects `ProviderStrategy` when the model profile
  declares native structured output, otherwise `ToolStrategy`; JSON Schema
  dictionaries must be wrapped explicitly. `ProviderStrategy` is described as the
  most reliable when available.
- Pydantic AI: Tool Output is the default "as it's supported by virtually all
  models and has been shown to work very well". Native Output requires the model
  to emit schema-compliant text. Prompted Output is "often the least reliable
  approach as the model is not forced to match the schema" and is the only option
  for models without tool or structured-output support.
- AI SDK: `Output.object({ schema })` is used inside `generateText`; "the schema
  is also used to validate the generated data". Structured-output generation
  counts as a step, which matters for `stopWhen`.

## Retry on invalid output

- LangChain (`handle_errors`, default on): a schema violation raises
  `StructuredOutputValidationError` and a wrong number of results raises
  `MultipleStructuredOutputsError`; both are fed back to the model as a
  `ToolMessage` error and the model is prompted to retry. `handle_errors` accepts
  a fixed message, an exception type/tuple, or a custom handler, and can be set
  to `False` to raise instead. **No explicit retry cap is documented** for agent
  structured output.
- Pydantic AI: each `ModelRetry` from an output validator consumes the run's
  output retry budget. **The budget defaults to 1** and is set via
  `Agent(retries={'output': N})`, `agent.run(retries={'output': N})`, or
  `ToolOutput(max_retries=N)`; exhaustion surfaces as `UnexpectedModelBehavior`.
- AI SDK: schema/parse failures reject with `NoObjectGeneratedError` (it
  preserves `text`, `response`, `usage`, `cause`). The docs do not describe an
  automatic schema-validation retry loop; a missing output throws
  `NoOutputGeneratedError`.

Practical reading: validate before consuming a result. Feedback and retry limits
depend on the library and caller; one correction is a reasonable bounded choice.

## Refusals and truncation are not schema errors

- AI SDK: `NoOutputGeneratedError` occurs when the final step "does not finish
  with a stop reason, for example when it finishes with `tool-calls`" — a
  termination/truncation class, separate from parse/validate failure.
- DeepSeek JSON Output: users must set `max_tokens` "reasonably to prevent the
  JSON string from being truncated midway", and "the API may occasionally return
  empty content" even under `response_format={'type':'json_object'}`.
- No surveyed library guarantees a non-empty, non-truncated, non-refusal response.
  Refusal, empty output, token-limit truncation, and content-filter stops must be
  detected from the finish reason/usage and treated as terminal failures, not
  silently retried as if invalid JSON.

## Library guarantees vs actual provider support

- A library strategy is a client contract. Only a provider-native "strict"
  schema mode is a **server-side** guarantee; LangChain reads its availability
  from a model profile rather than assuming it.
- DeepSeek's official API is OpenAI-compatible. It documents **JSON Output**
  (`response_format={'type':'json_object'}`; prompt must mention "json"; empty
  output and `max_tokens` truncation caveats above) and **Tool Calls**, whose
  strongest enforcement is **strict mode (beta)** requiring
  `base_url=https://api.deepseek.com/beta` and `strict: true` per function.
  Official-endpoint support does **not** imply the OpenCode Go/custom gateway
  used here exposes JSON mode, tool calling, or strict mode.
- A broadly-supported option, requiring gateway tool-call support, is the **final-result tool**
  (the `ToolStrategy`/`ToolOutput` family): the result is one tool call validated
  client-side, matching the project's existing `submit_review` tool. The OpenCode
  2.0.32 structured-output surface is verified separately by the primary.

## Project recommendation (primary synthesis)

1. Extend `submit_review` with required `decision` (`approve`, `request_changes`,
   `comment`) and `markdown`. Validate at the tool boundary and again at Runner's
   untrusted-output boundary. Schema compliance cannot establish review quality.
2. Return argument-validation errors inside the OpenCode tool loop, bounded by
   the existing job deadline. Retain one Runner reminder for a missing submission
   after normal completion; never silently repair or infer a decision.
3. Require exactly one successful submission and confirmed normal session
   completion. Multiple successful submissions are ambiguous and remain failures;
   a rejected invalid tool attempt is not a successful submission.
4. Refusal, truncation, process failure, and unresolved invalid output publish no
   vote. A `tool-calls` finish on an intermediate model turn is normal agent
   behavior, not by itself a failed session. Empty assistant text is also not
   invalid if the required result tool and session completion are valid.
5. Do not add another model or a framework just to format the result. Native strict
   output is an alternative only after the actual OpenCode/provider path proves it.

## OpenCode 2.0.32 boundary check

The isolated CLI's `run --help` advertises `--format json`, but no result-schema
flag. That flag selects event JSONL, not schema-constrained review output. The
[current API reference](https://opencode.ai/v2/docs/api/) `session.prompt` request
lists text, attachments, metadata, delivery and resume; no result-schema field.
This does not prove no other OpenCode surface supports structured output.
An isolated real 2.0.32 binary with a scripted local OpenAI-compatible endpoint
now proves the V2 plugin route (`ctx.tool.transform`, `codemode: false`):

- The model request includes `submit_review` with its enum/required-field schema.
- An invalid enum produces an OpenCode tool error requesting corrected arguments;
  the next model request includes that error.
- A valid enum with an invalid Markdown heading reaches the executor, whose thrown
  error is likewise returned to the next model request.
- A subsequent valid call completes in the same session. All three calls have
  the same session ID; no CLI relaunch occurs.
- A separate response containing only text exits 0 despite never submitting.
  Registration/schema alone therefore do not enforce mandatory final submission.
- The probe accepted two successive invalid attempts before the valid call:
  OpenCode does not supply the proposed one-correction budget automatically.

The tagged plugin SessionHooks expose prompt/context/model/HTTP/retry hooks, but
no dedicated pre-completion veto hook; AgentDomain exposes transforms, not such
a veto. Do not build an asynchronous idle-event restart and call it an atomic
completion gate. Runner must retain final validation and the bounded missing-
submission reminder inside the live Sandbox. Format correction belongs in the
OpenCode tool loop; the existing job deadline bounds in-agent correction without an extra retry controller.
These scripted probes establish the correction behavior. Subsequent real-model
sbx probes produced a valid decision submission and successful export through
both official and custom endpoint routes; see the
[auth upgrade research](opencode-auth-upgrade-research.md#implementation-probes-2026-10-18).

Sources: [V2 plugin API](https://opencode.ai/v2/docs/build/plugins/),
[tagged SessionHooks](https://github.com/anomalyco/opencode/blob/d4a6223d017e17f1beaa91d3e6ecc6511c5132ad/packages/plugin/src/promise/session.ts).

## Facts vs unknowns

Facts: LangChain distinguishes provider/tool/prompted strategies and retries
schema and multiple-output errors with feedback; Pydantic AI defaults to Tool
Output, documents three modes, and defaults its output retry budget to 1; AI SDK
validates with `Output.object` and raises `NoObjectGeneratedError` /
`NoOutputGeneratedError`; DeepSeek documents JSON Output (empty/truncation
caveats) and Tool Calls with beta strict mode.

Unused alternatives remain unverified: whether LangChain's agent retry loop has
an implicit cap, and whether the configured gateways expose DeepSeek strict mode
or provider-native schema. The implemented path uses the verified OpenCode tool
loop and export-based completion gate instead.
