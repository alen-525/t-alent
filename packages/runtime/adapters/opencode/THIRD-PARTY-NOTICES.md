# Third-party notices

This adapter uses the t-alent MIT License (`LICENSE`) and invokes the official `opencode-ai` CLI, version `1.18.32`, from the `anomalyco/opencode` project. OpenCode is distributed under the MIT License; its original notice is included as `LICENSE.opencode`.

The npm wrapper installs a matching platform binary (`opencode-darwin-*`, `opencode-linux-*`, or `opencode-windows-*`) as an optional dependency. The CLI bundles its runtime dependencies in that binary. No OpenCode source files are copied into this package.

The selected provider adapter is bundled by OpenCode 1.18.32: `@ai-sdk/openai-compatible` for OpenAI Chat Completions, `@ai-sdk/openai` for OpenAI Responses, and `@ai-sdk/anthropic` for Anthropic Messages. Their notices are distributed with the upstream binary/package.
