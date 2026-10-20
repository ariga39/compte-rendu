---
name: test-quality
description: Review whether changed behavior is covered by tests that would catch real regressions. Use when a diff adds or changes tests, or adds branches, validation, boundaries, async work, or error paths that need behavioral coverage.
license: Apache-2.0
---

# Test Quality

Assess coverage of changed behavior through the existing tests, callers and integration coverage. This is a static method: inspect evidence; do not require running tests, writing tests or coverage tools.

## Use when

- A diff adds or changes tests.
- New logic adds branches, validation, boundary conditions, concurrency, retries or error paths.
- A change claims to fix a bug but test evidence is unclear.

Do not use for style-only test cleanup or to demand 100% line coverage.

## Questions

1. What production change should make each new or changed test fail? Is that change a bug or only an intentional decision?
2. Does the test assert behavior through a public boundary, or does it inspect internal state, private calls or mock behavior?
3. Are expected values derived independently, or does the test reuse the implementation's logic and therefore always pass?
4. Are negative, boundary, empty, null, malformed, unauthorized and overflow cases covered where this change creates them?
5. For async, concurrent or retry behavior, is the relevant interleaving, ordering or exhaustion case asserted?
6. Do existing integration tests already cover the path? Would a new test duplicate them?
7. Is the test deterministic and isolated, or does it depend on shared state, time, network or ordering?
8. Do mocks replace only slow or external boundaries, while the behavior under test stays real?

## Example

Weak: `expect(mock).toHaveBeenCalledTimes(3)` says the mock was called, not that retry behavior is correct.

Stronger: assert the observable result and the number of real attempts, including the failure on the final attempt.

## Avoid

- Requiring a fixed number of tests or a coverage percentage.
- Matching implementation source text, constants or removed symbols instead of checking delivered behavior. Text assertions can be appropriate when the delivered text itself is the contract.
- Demanding tests for trivial forwarding, getters or framework mechanics.
- Turning a missing test into a finding without a concrete regression it would catch.

## Credits

Author: Daisy (daisy@anthropic.com), Anthropic. Upstream: [pr-test-analyzer.md](https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/pr-test-analyzer.md), commit `a0b04d9ddccaabe1976645f68b0eda50f74e7022`.

License: Apache-2.0. The upstream README says MIT, but the repository and plugin `LICENSE` at this pin are Apache-2.0; this adaptation follows the explicit LICENSE. See `LICENSE.md` and `NOTICE.md`.

Adapted by compte-rendu contributors: removed 1–10 ratings, fixed output/report sections, positive-observations requirements and rating-based prioritization; condensed to static review questions.
