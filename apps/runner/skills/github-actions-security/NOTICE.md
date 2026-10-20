# NOTICE

This skill adapts `gha-security-review` from Sentry.

- Upstream title: GitHub Actions Security Review
- Upstream author: Sentry (Functional Software, Inc. dba Sentry)
- Upstream source: https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/gha-security-review/SKILL.md
- Pinned commit: f57ada2d0b640406ea7e25b11d636c530e77c58b
- License: Apache-2.0
- Upstream copyright: Copyright 2025 Functional Software, Inc. dba Sentry (from the upstream LICENSE at this pin)
- Upstream NOTICE: none at this pin.
- Changes by compte-rendu contributors: removed Bash/Task requirements, report templates, fixed severity and blanket “safe patterns”; converted them into assumptions that require tracing downstream actions, reusable workflows, shell use and actual permissions.
