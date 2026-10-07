# AutoGPT packaging assessment (not registered)

No adapter or agent package is published for this candidate. This note records why the official open-source lineage was not accepted as a current, safe headless runtime.

## Candidate inspected

- Official repository: [Significant-Gravitas/AutoGPT](https://github.com/Significant-Gravitas/AutoGPT)
- Fixed source ref: `master` at `bfecefb75ac75e14854716d5552e269305c80ad0` (queried from `git ls-remote` on 2026-10-07).
- Official source archive: [codeload archive for the fixed commit](https://codeload.github.com/Significant-Gravitas/AutoGPT/legacy.zip/bfecefb75ac75e14854716d5552e269305c80ad0), SHA-256 `69a15a3e8a6d235b4c19d4f7120c2b82fa3656da1cf1eaca0fe9f121fccdba18` (193,015,149 bytes).
- The exact `classic/pyproject.toml` reports `autogpt-classic` version `0.5.0`, Python `^3.12`, and MIT. The root LICENSE says everything outside `autogpt_platform/` is MIT, while `autogpt_platform/` is Polyform Shield. The Platform is therefore excluded from any open-source label.

## Why it is not packaged

The official Classic documentation says it is unsupported and its dependencies will not be updated. The repo security policy calls `classic/` legacy and out of scope for security reports. At the time checked, the official repository also had a high-severity Classic SSRF advisory affecting versions below 0.6.66, while the inspected official source manifest still says 0.5.0. The official PyPI index had no `autogpt-classic` project metadata, so there was no fixed wheel that could resolve that version/source discrepancy.

The original Classic `Agent` constructs `FileManagerComponent`, `CodeExecutorComponent`, `WebSearchComponent`, and `WebPlaywrightComponent`. `CodeExecutorComponent` only registers Python execution commands when Docker is available; Docker is absent on the verification host. We did not install Docker or replace AutoGPT's action loop. A no-Docker package would omit a core native command family and has not been proven to run the original loop headlessly with only workspace file operations.

This assessment does not say AutoGPT Classic is not MIT. It distinguishes the correctly licensed Classic code from the separately licensed Platform and records why this particular unsupported, vulnerable, unverified runtime was left unregistered.

## Primary references

- [Classic project status](https://github.com/Significant-Gravitas/AutoGPT/blob/bfecefb75ac75e14854716d5552e269305c80ad0/classic/README.md)
- [Classic packaging metadata](https://github.com/Significant-Gravitas/AutoGPT/blob/bfecefb75ac75e14854716d5552e269305c80ad0/classic/pyproject.toml)
- [Original native Agent components](https://github.com/Significant-Gravitas/AutoGPT/blob/bfecefb75ac75e14854716d5552e269305c80ad0/classic/original_autogpt/autogpt/agents/agent.py)
- [Docker-gated native code executor](https://github.com/Significant-Gravitas/AutoGPT/blob/bfecefb75ac75e14854716d5552e269305c80ad0/classic/forge/forge/components/code_executor/code_executor.py)
- [Classic security policy](https://github.com/Significant-Gravitas/AutoGPT/blob/bfecefb75ac75e14854716d5552e269305c80ad0/SECURITY.md)
- [High severity Classic SSRF advisory](https://github.com/Significant-Gravitas/AutoGPT/security/advisories/GHSA-vj3m-g4cv-8j93)
- [Official license boundary](https://github.com/Significant-Gravitas/AutoGPT/blob/bfecefb75ac75e14854716d5552e269305c80ad0/LICENSE)
