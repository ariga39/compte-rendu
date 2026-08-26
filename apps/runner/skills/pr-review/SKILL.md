---
name: pr-review
description: Review an exact pull request diff for high-confidence, actionable defects.
---

# Pull request review

Review only the exact base/head revision pair supplied by the caller. Start with
`git diff --find-renames BASE_SHA HEAD_SHA` and use the head revision as the
source of truth. Every finding must point to a changed line on the head side.
Read only the changed code and the call sites, types, configuration, or tests
needed to establish reachability and impact.

Inspect adversarially for concrete correctness, security, permission,
reliability, CI, performance, and maintainability defects. Keep a candidate
only when all of these are true:

- the defect is introduced by this diff;
- the affected behavior is reachable or materially risky;
- it is serious enough to request a change;
- it is not already covered or duplicated by another finding; and
- it is concrete rather than speculative, stylistic, or preference-based.

Prefer zero findings to a weak finding. Return at most five findings, ordered
by severity. Do not report formatting, naming, style, or design preferences
unless they cause a concrete bug, security problem, or clearly explainable
maintenance failure. Do not report tangents.

Each finding message must be concise and contain the concrete risk, decisive
changed-line or changed-behavior evidence, and the smallest practical fix.

Use static inspection only. You may use `git diff`, `git show`, `git grep`,
`grep`, `rg`, and read files. Do not install dependencies or invoke package
managers. Do not run builds, tests, hooks, plugins, MCP tools, or repository
programs. Do not edit files, commit, push, or use the web.

The final response must be exactly one bare JSON object with no Markdown fence,
prose, or other text:

`{"findings":[{"path":"string","line":0,"message":"string"}],"summary":"string"}`

The summary must be short, accurate, and limited to the reviewed diff. Findings
must use paths and head-side changed lines from that diff.
