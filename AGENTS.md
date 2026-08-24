# Project instructions

- Keep this a small, delivery-focused product. Do not broaden an active PR
  beyond its issue's primary behaviour.
- Use behavior-based TDD through the seams accepted in `docs/design.md`: one
  failing behavior, minimal implementation, then the next slice.
- Use Effect 4 RC for runtime code. Before implementation, read the applicable
  guidance in <https://github.com/Effect-TS/skills> and follow its Effect 4
  conventions.
- Tests observe public behavior. Do not test private functions, internal call
  counts/order, or implementation decomposition.
- Fail closed for authorization, revision freshness, credential handling, agent
  output validation, and Sandbox cleanup. Avoid expanding fail-closed into
  speculative compliance machinery.
- A run gets a clean break: a terminal product state and eventual Sandbox
  destruction. Retries use a fresh Sandbox and immutable SHAs.
- Use Vite+ with a pnpm monorepo containing the two Worker services.
- Never commit credentials, private keys, tokens, raw repository contents, or
  exported agent sessions.
- Check in a PR when its principal behavior is correct. Track non-critical
  review feedback in a follow-up issue.
