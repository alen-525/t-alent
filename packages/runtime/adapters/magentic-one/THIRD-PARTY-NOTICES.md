# Third-party notices

The runtime embeds Microsoft's official AutoGen `autogen-agentchat`, `autogen-ext`, and `autogen-core` 0.7.5 wheels. The PyPI files are MIT licensed; their verified URLs, SHA-256 digests, source tag and commit are recorded in `agent-sources/magentic-one/0.2.0.json`. The installed `LICENSE-CODE` is reproduced in `LICENSE.autogen`.

The setup script also installs the pinned AutoGen OpenAI extra to provide AutoGen's `OpenAIChatCompletionClient`; the exact resolved runtime versions are written to the private runtime `runtime.json` lock record. These third-party dependencies retain their own licenses in the virtual environment.
