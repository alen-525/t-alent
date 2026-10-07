# Third-party notices

## CrewAI

The runtime uses the official `crewai` 1.15.23 PyPI wheel. Its wheel is MIT-licensed. The upstream repository license is preserved as `LICENSE.crewai`. Wheel URL and SHA-256 are recorded in `agent-sources/crewai/0.2.0.json`.

## CrewAI Tools

The runtime uses the official `crewai-tools` 1.15.23 PyPI wheel, including its official FileReadTool and FileWriterTool implementations. This distribution is published from the same upstream repository and covered by the same MIT license preserved as `LICENSE.crewai`. Wheel URL and SHA-256 are recorded in `agent-sources/crewai/0.2.0.json`.

The installed dependency graph is resolved by pip from these pinned wheel manifests. Optional integrations (web, browser, MCP, and external-app tools) are not configured or exposed by this adapter.

## Adapter

The adapter and its prompts are licensed under MIT; see `LICENSE`.
