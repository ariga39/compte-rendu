# Historical research and experiments

These documents preserve dated sources, PoCs, migration decisions and superseded
plans. They are not installation instructions or a list of implemented features.
Use the [current documentation](../README.md) first. Historical commands, versions
and unimplemented alternatives are retained as evidence, not renewed commitments.

## Sandbox and infrastructure

- [Sandbox/OpenCode remote PoC](sandbox-opencode-poc.md)
- [Agent sandbox alternatives to Docker Sandboxes (sbx 0.39)](agent-sandbox-alternatives-research.md)
- [Docker sbx versus NVIDIA OpenShell for static PR review](sbx-openshell-comparison.md)
- [Docker Sandboxes OpenCode custom template research](docker-sandbox-custom-template-research.md)
- [Docker Sandbox GitHub authentication decision for issue #99](docker-sandbox-custom-secret-auth-research.md)
- [Docker Sandbox threat model for the PR-review runner](docker-sandbox-security-threat-model.md)
- [Current-architecture security FMEA](security-fmea.md)
- [Cloudflare Durable Object retirement (issue #77)](cloudflare-durable-object-retirement.md)
- [Workers VPC deployment and operations research](workers-vpc-deployment-operations-research.md)
- [Workers VPC Service HTTP scheme](workers-vpc-service-http-scheme.md)

## Agent, output and model service

- [OpenCode 1 vs 2: auth and Runner-compatibility research](opencode-auth-upgrade-research.md)
- [OpenCode final review output for issue #105](opencode-final-review-output-research.md)
- [OpenCode final Markdown review submission research](opencode-final-review-submission-research.md)
- [Review output reliability: structured-output best practice](review-output-reliability-research.md)
- [PR review skill source synthesis](pr-review-skill-research.md)
- [Topic-specific review skills research (#211)](topic-review-skills-research.md)
- [Expanded topic and comprehensive review skill comparison](review-skills-expanded-research.md)
- [Complete pull-request context from GitHub](pr-context-github-api-research.md)
- [External LLM service design](llm-service-design.md)

## Dashboard and operations

- [Dashboard design-system research](dashboard-design-system-research.md)
- [Runner concurrency hot reload: library choice (#161)](runner-settings-reload-research.md)
- [PostHog observability fit](posthog-observability-research.md)

- [Review-oriented skills and native review commands](review-oriented-skills-research.md): source comparison and decision to use one general review skill.
