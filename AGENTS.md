# Project instructions

- Keep this a small, delivery-focused product. Do not broaden an active PR
  beyond its issue's primary behaviour.
- Manage dependent pull requests as a stack following [GitHub’s stacked PR guidance](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs).
- Treat this as a self-hosted, single-operator product. Upgrade the Worker and
  Runner together in a brief maintenance window; mixed-version rolling
  compatibility is not a default requirement. Breaking changes are deliberate,
  and a temporary compatibility path needs a concrete reason, a removal date and
  a cleanup issue. Losing a rare in-flight or undelivered review during an
  upgrade or crash is acceptable: re-trigger it in a fresh Sandbox once same-PR
  admission is eligible (an expired pending claim, or confirmed destruction after
  `cleanup=failed`; see [recovery](docs/operations.md#operations-and-troubleshooting)).
- Use behavior-based TDD through the seams accepted in `docs/design.md`: one
  failing behavior, minimal implementation, then the next slice.
- Use stable Effect 4 for runtime code. Before implementation, read the applicable
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
