# Development and maintenance

## Local development

```bash
bun install
bun run typecheck
bun test
```

Install the working tree into a project by creating `.opencode/plugins/otel/index.ts` (see [installation.md](./installation.md#local-development)).

The integration suite runs the pinned OpenCode SDK in a real subprocess with a scripted model endpoint and an OTLP/JSON receiver:

```bash
bun run test:integration
```

It needs Git but no model credentials, Docker, or external telemetry service. See [tests/integration/README.md](../tests/integration/README.md) for coverage and how to extend it.

`bun run lint` and `bun run check:jsdoc-coverage` run in CI alongside typecheck and tests. The commit convention is [Conventional Commits](https://www.conventionalcommits.org/); release-please derives the version from the commit history.

## GitHub Discord notifications

This repo includes a reusable workflow at `.github/workflows/discord-notify.yml` that posts a Discord embed for `issues.opened`, `pull_request.opened`, and `release.published`. Set a repository or org secret named `DISCORD_WEBHOOK` to enable it.

To reuse it from another repository under the same account:

```yaml
name: Discord Events
on:
  issues:
    types: [opened]
  pull_request:
    types: [opened]
  release:
    types: [published]
jobs:
  notify-discord:
    uses: chenryn/opencode-plugin-otel/.github/workflows/discord-notify.yml@main
    with:
      username: chenryn Bot
      title_prefix: "[chenryn]"
      include_body: true
    secrets:
      discord_webhook: ${{ secrets.DISCORD_WEBHOOK }}
```

Workflow inputs: `username`, `avatar_url`, `title_prefix`, `include_body`, and `color`.
