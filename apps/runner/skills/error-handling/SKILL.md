---
name: error-handling
description: Review how changed code detects, propagates, retries, cleans up and surfaces failures, especially fallbacks that hide them. Use when a diff touches catches, result types, error mapping, retries, timeouts, cleanup, defaults or fallback behavior.
license: Apache-2.0
---

# Error Handling

Inspect failure paths statically, using the changed code, callers, configuration and tests. Do not require execution or prescribe project-specific logging libraries.

## Use when

- A diff adds or changes try/catch, `Result`, error callbacks or error responses.
- A diff adds fallbacks, default values, retries, timeouts, cancellation or cleanup.
- A failure can be swallowed, misclassified or reported as success.

Do not use for ordinary control flow that has no failure semantics.

## Questions

1. Which errors are expected and which are unexpected? Does the handler catch only the expected scope?
2. Should this error be propagated, translated or handled here? Does that match the caller's contract?
3. Does a fallback preserve correctness, or can it hide data loss, stale state, a permission failure or a partial write?
4. Is the fallback explicit, bounded and justified by the feature, rather than a silent default?
5. Does cleanup run on success, failure, cancellation and timeout paths? Can it mask the original error?
6. Does retry have a bound, a reason, a backoff or budget, and an exhaustion signal? Is the operation idempotent?
7. Is the error message sufficient for the intended audience without exposing secrets or internals?
8. Does swallowing here prevent an upstream retry, compensation or user recovery step?

## Example

A database outage is caught and `[]` is returned, so the UI shows “no results” instead of a failure. That hides loss of availability and may lead to a destructive follow-up action.

Better review question: can the caller distinguish “empty” from “could not read”, and does the UI take the correct action?

## Avoid

These are review questions, not blanket rules:

- Do not treat every silent failure as critical; assess the concrete consequence.
- Do not forbid every empty catch; require a justification grounded in the changed behavior.
- Do not import project-specific `logError`, Sentry, Statsig or `errorIds.ts` conventions.
- Do not require user-facing feedback for every error, especially in libraries and background jobs.
- Do not require a new error type, wrapper or logging call without a concrete failure it prevents.

## Credits

Author: Daisy (daisy@anthropic.com), Anthropic. Upstream: [silent-failure-hunter.md](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/silent-failure-hunter.md), commit `a0b04d9ddccaabe1976645f68b0eda50f74e7022`.

License: Apache-2.0. The upstream README says MIT, but the repository and plugin `LICENSE` at this pin are Apache-2.0; this adaptation follows the explicit LICENSE. See `LICENSE.md` and `NOTICE.md`.

Adapted by compte-rendu contributors: removed blanket criticality, empty-catch prohibition, project-specific logging/error-ID rules, fixed severity/output formats and tone guidance; retained propagation, cleanup, retry-exhaustion and fallback-justification questions.
