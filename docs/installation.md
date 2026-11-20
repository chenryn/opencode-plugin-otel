# Installation

The `2.x` line requires OpenCode V2 (`>=2`). The V1 plugin lives on the [`v1` branch](https://github.com/chenryn/opencode-plugin-otel/tree/v1) and is released from the `1.x` line.

| Plugin line | OpenCode | Config key | Entrypoint |
|-------------|----------|------------|------------|
| `2.x` (`main`) | V2 (`>=2`) | `plugins` | default export `{ id, setup }` |
| `1.x` (`v1` branch) | V1 | `plugin` | named `OtelPlugin` export |

## From GitHub

Add this to `~/.config/opencode/opencode.json` (no npm account needed):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["github:chenryn/opencode-plugin-otel"]
}
```

OpenCode installs the package on first start and reloads it on config changes. Other valid targets are a branch, tag, full commit hash, or a subdirectory selector:

```json
{
  "plugins": [
    "github:chenryn/opencode-plugin-otel#main",
    "git+ssh://git@github.com/chenryn/opencode-plugin-otel.git#main"
  ]
}
```

Or use the CLI:

```bash
opencode plugin add github:chenryn/opencode-plugin-otel
opencode plugin list
opencode plugin update github:chenryn/opencode-plugin-otel
```

## With options

Use the object form. The `package` field is the npm name declared in `package.json`; OpenCode resolves it to the same plugin regardless of how it was installed:

```json
{
  "plugins": [
    {
      "package": "@chenryn/opencode-plugin-otel",
      "options": { "enabled": true, "guardEnabled": true }
    }
  ]
}
```

## From npm

Once `@chenryn/opencode-plugin-otel` is published, it can be installed by name:

```json
{
  "plugins": ["@chenryn/opencode-plugin-otel"]
}
```

## Plugin ID

The plugin's runtime **ID** is `chenryn.otel` — use it to disable or re-enable the plugin with the `plugins` control syntax (`"-chenryn.otel"`, `"chenryn.*"`). If you also have a fork with a different ID, keep them distinct to avoid OpenCode's duplicate-ID error.

## Local development

Install dependencies with `bun install` and create `.opencode/plugins/otel/index.ts` in the project where OpenCode runs:

```ts
export { default } from "/path/to/opencode-plugin-otel/src/index.ts"
```

OpenCode V2 discovers this directory automatically. On OpenCode `2.0.1`, a `plugins` entry pointing directly to an absolute `.ts` file is rejected — the package loader expects a directory.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the development workflow and [development.md](./development.md) for tests and maintenance workflows.
