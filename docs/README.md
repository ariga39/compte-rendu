# Documentation

These guides describe the supported implementation. They separate current behavior
from experiments and proposals; a research recommendation is not a shipped feature.

| Need                                                             | Read                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Understand admission, jobs, publication and component boundaries | [Architecture](design.md)                                                                                                                                                                                  |
| Install an instance or change deployment settings                | [Installation](installation.md)                                                                                                                                                                            |
| Diagnose failures, upgrade, roll back or uninstall               | [Operations](operations.md)                                                                                                                                                                                |
| Configure model routes, credentials and job grants               | [Inference relay](llm-service.md)                                                                                                                                                                          |
| Select one or several reviewers without restarting               | [Review configuration](review-configuration.md)                                                                                                                                                            |
| Understand the final result, decisions and publication checks    | [Review decisions](review-decisions-design.md)                                                                                                                                                             |
| Understand dashboard state, privacy and refresh                  | [Dashboard](public-dashboard-design.md)                                                                                                                                                                    |
| Understand trust boundaries and known limitations                | [Security](security.md)                                                                                                                                                                                    |
| Understand local Worker integration coverage                     | [Runtime tracer](local-runtime-tracer.md)                                                                                                                                                                  |
| Sign in and grant operator access                                | [Dashboard authorization](review-configuration.md#dashboard-sign-in-and-model-settings)                                                                                                                    |
| Stop a queued or running review                                  | [Operator cancellation](operations.md#operator-cancellation)                                                                                                                                               |
| Run reviews with the microsandbox backend                        | [microsandbox](microsandbox.md)                                                                                                                                                                            |
| Find older PoCs, source research and migration decisions         | Removed from `main`: [#406](https://github.com/ariga39/compte-rendu/issues/406) · [archive at e9ba46d](https://github.com/ariga39/compte-rendu/tree/e9ba46dd063c7775e8f86d7514acedc28ae8f40f/docs/archive) |

For end users, the dashboard's `/help` page is rendered from
[Help Markdown](../apps/dashboard/src/lib/content/help.md).

## Maintenance

Update the guide that owns a behavior when its code changes. Keep operational
commands in the installation/service guides, not duplicated in the architecture.
Mark unimplemented requirements explicitly and link an issue. Do not turn old
research alternatives or a historical experiment's limitations into current
promises. Keep superseded plans in the linked issue or the historical archive,
with their dates, sources and results intact.

## Tracked gaps

These are not shipped guarantees. Historical alternatives and optional hardening
suggestions are not automatically backlog commitments.

| Gap                                     | Issue                                                      |
| --------------------------------------- | ---------------------------------------------------------- |
| Cancellation lifecycle telemetry        | [#268](https://github.com/ariga39/compte-rendu/issues/268) |
| Crash-time owned Sandbox reconciliation | [#66](https://github.com/ariga39/compte-rendu/issues/66)   |
