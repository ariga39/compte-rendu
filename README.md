# Compte rendu

Compte rendu is a self-hosted GitHub App for AI code review. It runs OpenCode on pull requests and posts the findings where contributors already discuss changes. You can use one model or ask several models to review independently and combine their findings into a single GitHub review.

[See a review on GitHub](https://github.com/ariga39/compte-rendu/pull/318#pullrequestreview-6013002477) · [View the same run in the dashboard](https://reviews.ariga39.dev/jobs/f753a08b-5dd8-4396-9b45-b4f027b700ae)

## Using Compte rendu

After installation, open a pull request from a branch in your repository or mark a draft ready for review. For a pull request from a public fork, a maintainer with write access can comment `/ai-review` to review the current revision.

Each run gets a fresh sandbox. The GitHub Check links to a dashboard where you can follow progress and inspect token usage by model. Before publishing an approval, a request for changes, or a comment, the App checks that the reviewed commit is still current.

## Installation

You’ll need a GitHub App, a Cloudflare account, model provider credentials, and a host for the Runner. Cloudflare serves the dashboard, coordinates jobs and routes model requests through AI Gateway. Your Runner executes the reviews. Once the instance is running, authorized operators can change models from the dashboard.

[Installation guide](docs/installation.md) · [Model configuration](docs/review-configuration.md) · [All documentation](docs/README.md)

## Contributing

To work on the project, install dependencies with `corepack pnpm install`. Run `corepack pnpm check` and `corepack pnpm test` to check your changes. For dashboard work, preview task states locally with `corepack pnpm --filter @compte-rendu/dashboard storybook`.

[Architecture](docs/design.md) · [Report an issue](https://github.com/ariga39/compte-rendu/issues)
