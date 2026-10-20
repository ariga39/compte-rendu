# NOTICE

This skill adapts `silent-failure-hunter` from the PR Review Toolkit.

- Upstream title: PR Review Toolkit — silent-failure-hunter
- Upstream author: Daisy (daisy@anthropic.com), Anthropic
- Upstream source: https://github.com/anthropics/claude-plugins-official/blob/a0b04d9ddccaabe1976645f68b0eda50f74e7022/plugins/pr-review-toolkit/agents/silent-failure-hunter.md
- Pinned commit: a0b04d9ddccaabe1976645f68b0eda50f74e7022
- License: Apache-2.0 (the repository LICENSE and plugins/pr-review-toolkit/LICENSE at this pin)
- License discrepancy: the upstream README says MIT, but the LICENSE files at this pin are Apache-2.0. This adaptation uses Apache-2.0.
- Upstream NOTICE: none at this pin. The Apache-2.0 LICENSE text contains no explicit copyright line; the upstream README attributes authorship to Daisy.
- Changes by compte-rendu contributors: removed blanket criticality, empty-catch prohibition, project-specific logging/error-ID rules, fixed severity/output formats and tone guidance; retained propagation, cleanup, retry-exhaustion and fallback-justification questions.
