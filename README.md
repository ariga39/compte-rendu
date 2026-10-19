# Compte rendu

A small GitHub App that runs AI pull-request reviews on Cloudflare, outside
GitHub Actions.

Start with the [documentation index](docs/README.md) and
[current architecture](docs/design.md).

Operators can install and run the deployed Workers from
[docs/installation.md](docs/installation.md). Evidence is retained in a
private R2 bucket with a deployment-configured lifecycle expiration.
The standalone [LLM service deployment guide](docs/llm-service.md) covers the
host-side inference service and its sbx Runner integration.

To print one sanitized correlated diagnosis, pass an explicit deployed
database, bucket, and generated config:

```sh
DIAGNOSTIC_D1_DATABASE=petit-chiba-review-state \
DIAGNOSTIC_R2_BUCKET=petit-chiba-review-evidence \
DIAGNOSTIC_WRANGLER_CONFIG=apps/dashboard/wrangler.petit-chiba.jsonc \
corepack pnpm diagnose <PR_URL|DELIVERY_ID|RUN_ID>
```

The command reads GitHub, D1, and private R2 and never prints credentials,
repository contents, review bodies, or raw session/tool output.
