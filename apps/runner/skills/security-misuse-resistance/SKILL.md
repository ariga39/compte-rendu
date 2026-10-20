---
name: security-misuse-resistance
description: Review whether security-relevant APIs, defaults and configuration make the unsafe choice the easy choice. Use when a diff changes authentication, authorization, sessions or tokens, secret validation, cryptography, security defaults, or a public API that lets callers choose security behavior.
license: CC-BY-SA-4.0
---

# Security Misuse Resistance

Apply the pit-of-success lens: secure use should be the path of least resistance. This is a static review method; inspect the changed design and its callers without writing code, running programs or adding an agent.

## Use when

- A diff exposes security choices to callers or operators.
- A default, zero/empty/null value or configuration combination can disable protection.
- Authentication, authorization, cryptography, sessions, tokens or secret handling changes.

Do not use for general correctness, business-logic abuse or ordinary implementation bugs.

## Questions

1. Does the API let a caller select an algorithm, mode, hash, cipher or security primitive? Can untrusted input influence that choice?
2. What happens with `0`, `""`, `null`, negative values, an empty list or an omitted option? Does it disable security, change meaning or fail open?
3. Is the default the safest usable option, or does the caller have to remember a security rule to avoid harm?
4. Are distinct security concepts separate types, or can keys, nonces, ciphertexts, signatures and plain text be swapped without a type error?
5. Is comparison of secrets, tokens or MACs timing-safe? Can the same-looking API be used unsafely?
6. Can configuration precedence, precedence between sources, or a dangerous combination silently weaken protection?
7. Do failures return a permissive default, skip validation or suppress the error? Is the failure visible to the caller?
8. Are security values stringly typed or accepted from an unbounded enum, so invalid or weaker values remain expressible?

## Examples

- A JWT verifier accepts the algorithm from the token header, allowing `none` or algorithm confusion.
- An OTP lifetime of `0` means “never expires” in one branch and “already expired” in another; the ambiguity is the defect.
- Raw byte parameters for key, nonce and ciphertext can invite swapping; check callers and API naming before recommending semantic types or other additional structure.
- A variable-time comparison of attacker-supplied and secret authentication values can expose timing differences; check the actual comparison implementation and whether the difference is observable.

## Static validation

- Trace the changed call path, existing configuration and tests before reporting.
- Establish a concrete consequence in this change; a checklist item alone is not a finding.
- If proof would require writing or executing code, state the evidence limit instead of claiming exploitability.
- Treat all patterns as hypotheses; the shared review contract decides whether a finding is actionable.

## Do not import

- The upstream agent workflow, auto-dispatch or report format.
- The upstream severity table or “always flag” lists as a second scoring system.
- Language-specific reference bundles when the changed technology does not match.
- The assumption that every numeric zero, empty string or broad API is a defect.

## Credits

Author: Trail of Bits. Upstream: [sharp-edges/SKILL.md](https://github.com/trailofbits/skills/blob/5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0/plugins/sharp-edges/skills/sharp-edges/SKILL.md), commit `5c99c03fb8a9ea568432ecbcba5d86e9f4ac2bf0`.

License: CC-BY-SA-4.0. This adaptation remains CC-BY-SA-4.0; see `LICENSE.md` and `NOTICE.md`. No upstream NOTICE file exists at this pin.

Adapted by compte-rendu contributors: removed agent dispatch, proof-by-writing/execution, the severity table, language-specific bundles and reporting instructions; condensed the categories into static review questions and examples. Changes are licensed under CC-BY-SA-4.0.
