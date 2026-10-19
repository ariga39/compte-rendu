# Documentation

These guides describe the supported implementation. They separate current behavior
from experiments and proposals; a research recommendation is not a shipped feature.

| Need                                                             | Read                                            |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| Understand admission, jobs, publication and component boundaries | [Architecture](design.md)                       |
| Install an instance or change deployment settings                | [Installation](installation.md)                 |
| Diagnose failures, upgrade, roll back or uninstall               | [Operations](operations.md)                     |
| Configure model routes, credentials and job grants               | [LLM service](llm-service.md)                   |
| Select one or several reviewers without restarting               | [Review configuration](review-configuration.md) |
| Understand the final result, decisions and publication checks    | [Review decisions](review-decisions-design.md)  |
| Understand dashboard state, privacy and refresh                  | [Dashboard](public-dashboard-design.md)         |
| Understand trust boundaries and known limitations                | [Security](security.md)                         |
| Understand local Worker integration coverage                     | [Runtime tracer](local-runtime-tracer.md)       |
| Find older PoCs, source research and migration decisions         | [Archive](archive/README.md)                    |

For end users, the dashboard's `/help` page is rendered from
[Help Markdown](../apps/dashboard/src/lib/content/help.md).

## Maintenance

Update the guide that owns a behavior when its code changes. Keep operational
commands in the installation/service guides, not duplicated in the architecture.
Mark unimplemented requirements explicitly and link an issue. Do not turn old
research alternatives or a historical experiment's limitations into current promises.
Archive superseded plans with their dates, sources and results intact.

## Tracked gaps

These are not shipped guarantees. Historical alternatives and optional hardening
suggestions are not automatically backlog commitments.

| Gap                                                                | Issue                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Crash-time owned Sandbox reconciliation                            | [#66](https://github.com/ariga39/compte-rendu/issues/66)   |
| Drawer focus fallback after the selected row disappears            | [#170](https://github.com/ariga39/compte-rendu/issues/170) |
| Operator maintenance drain without interrupting admitted jobs      | [#194](https://github.com/ariga39/compte-rendu/issues/194) |
| Supported recovery after terminal callback delivery is exhausted   | [#195](https://github.com/ariga39/compte-rendu/issues/195) |
| Metadata refresh backlog visibility and capacity validation        | [#196](https://github.com/ariga39/compte-rendu/issues/196) |
| Consistent overview counters and current-row snapshot              | [#197](https://github.com/ariga39/compte-rendu/issues/197) |
| Actual model and per-job token accounting (next requested feature) | [#198](https://github.com/ariga39/compte-rendu/issues/198) |
