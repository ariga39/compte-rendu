---
name: github-actions-security
description: Review GitHub Actions workflows and local actions for vulnerabilities exploitable by an external attacker. Use when a diff changes .github/workflows, action.yml, composite actions, reusable workflows or CI configuration that handles PR-controlled input, secrets, tokens or runners.
license: Apache-2.0
---

# GitHub Actions Security

Trace complete attack paths from an untrusted trigger to a privileged execution context. Review statically from workflow and action definitions; do not require executing workflows or editing files.

## Use when

- Workflows are added or changed.
- A workflow checks out PR code, consumes PR text, or loads configuration from a checkout.
- Permissions, secrets, OIDC, self-hosted runners, caches, artifacts or third-party actions change.

## Questions

1. Which triggers accept external input: fork PR, issue comment, branch name, PR title/body, commit message, `workflow_run` or `workflow_call`?
2. Is an attacker-controlled value interpolated into a shell/script block, or does it reach a shell later through an environment variable, action input or generated file?
3. Does `pull_request_target` or another privileged trigger check out PR head, a local action or a config file from the PR?
4. Can a downstream action, composite action or reusable workflow consume PR-controlled files or outputs even if the top-level workflow looks safe?
5. What are the actual `GITHUB_TOKEN` permissions, secrets and OIDC subjects for this job? Do repository/organization defaults change the answer?
6. Are third-party actions and reusable workflows pinned to a full commit SHA? Is the job privileged enough for compromise to matter?
7. Are self-hosted runners, caches or artifacts shared with untrusted jobs or retained across trust boundaries?
8. Does an `issue_comment` command verify authorization for the requested action? A broad `author_association` category alone may not establish that permission.

## Heuristics to verify, not exemptions

Trace the actual path before accepting any of these as safe:

- `pull_request_target` without a fork checkout can still pass untrusted data to a downstream action.
- `env` and `with` avoid direct shell interpolation but may feed a later shell, action or reusable workflow.
- `pull_request` is not universally read-only; permissions and runner context can differ.
- First-party action tags are a policy choice, not proof the action or its dependencies are uncompromised.

## Example

A PR title is interpolated into the script text before the shell parses it. The concrete path is: attacker edits title → privileged workflow constructs the script → injected syntax executes with the job's token.

A later workflow that passes the title through `env` is not automatically safe; check every consumer, including actions that build shell commands.

## Avoid

- Reporting theoretical patterns without an entry point, execution path, impact and required permissions.
- Treating “unpinned third-party action” as a finding when the job has no meaningful privilege.
- Applying the external-attacker model to insiders or stolen tokens without saying so.

## Credits

Author: Sentry (Functional Software, Inc. dba Sentry). Upstream: [gha-security-review/SKILL.md](https://github.com/getsentry/skills/blob/f57ada2d0b640406ea7e25b11d636c530e77c58b/skills/gha-security-review/SKILL.md), commit `f57ada2d0b640406ea7e25b11d636c530e77c58b`.

License: Apache-2.0, copyright 2025 Functional Software, Inc. dba Sentry. See `LICENSE.md` and `NOTICE.md`.

Adapted by compte-rendu contributors: removed `Bash`/`Task` requirements, report templates, fixed severity and blanket “safe patterns”; converted them into assumptions that require tracing downstream actions, reusable workflows, shell use and actual permissions.
