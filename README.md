# Compte rendu

A small GitHub App that runs AI pull-request reviews on Cloudflare, outside
GitHub Actions.

The accepted v1 architecture and delivery plan are in
[docs/design.md](docs/design.md).

Operators can install and run the deployed Workers from
[docs/installation.md](docs/installation.md). Evidence is retained in a
private R2 bucket with a deployment-configured lifecycle expiration.
