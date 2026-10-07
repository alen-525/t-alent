# BabyAGI packaging assessment (not registered)

No adapter or agent package is published for these candidates. The official name currently spans two materially different agents, and neither satisfies the requested source, credential, and model constraints without replacing or patching upstream behavior.

## Current Functionz/self-building repository

- Official repository: [yoheinakajima/babyagi](https://github.com/yoheinakajima/babyagi)
- Fixed source ref: `main` at `fa8930ebe72a82e5ad57b356e7cbec96290e5bb2` (queried from `git ls-remote` on 2026-10-07).
- Official source archive: [codeload archive for the fixed commit](https://codeload.github.com/yoheinakajima/babyagi/legacy.zip/fa8930ebe72a82e5ad57b356e7cbec96290e5bb2), SHA-256 `d077f942a1ec2b46101adf1b74af4376b41c12c8d78961a81f54016281723f66` (536,053 bytes).
- README identifies the project as an experimental self-building Functionz framework and warns it is not meant for production. Its actual agent entries include `react_agent` and `process_user_input` / the `code_writing_functions` pack.
- On this exact commit, `pyproject.toml` says version `0.0.8`, `setup.py` says `0.1.2`, `requirements.txt` is unpinned, and `LICENSE` is absent (the pinned raw URL returns 404). The README and MANIFEST claim MIT/include LICENSE, but that file is missing from the archive. This is not a reproducible, fully licensed release source.
- PyPI `babyagi==0.1.4` does publish an MIT license classifier and has wheel SHA-256 `1e77f602ef75ffe960641b63697c8854b2642ebdd9276dbf8a0f3ccc72797a33`; inspection shows it is the Functionz framework, not a `BabyAGI.from_llm` API. In its native Functionz executor, dependency imports can trigger `pip install`, and stored function source is executed with Python `exec`. The current `react_agent` also hard-codes `gpt-4-turbo` and declares `OPENAI_API_KEY` as a Functionz key dependency; native key injection reads secrets from the database. Adapting it to a host model profile without changing upstream source would require model rewrites/monkeypatches, and using its normal key mechanism would persist the key.

## Archived original task-planning agent

The distinct [babyagi_archive](https://github.com/yoheinakajima/babyagi_archive) project is an MIT-licensed September 2024 snapshot. Its fixed current `main` commit is `e8726e3f83b81e51bdbfebf6df6ab034d52e58ec`; archive SHA-256 is `8a589eb45a384f1284e1c0d9fee82b755e986a64c031c09497e18c838a4d259c` (1,193,195 bytes). It contains the original task creation, prioritization, execution loop and local Chroma result store.

That script lowercases `LLM_MODEL` at startup, routes non-`gpt-` identifiers through the legacy completion API, and uses OpenAI embeddings for Chroma unless configured for local Llama. The host model contract here exposes only chat completions and must preserve arbitrary identifiers exactly. We did not rewrite the model router or claim a fake embedding/vector store to make this snapshot appear compatible.

## Primary references

- [Current Functionz/self-building README](https://github.com/yoheinakajima/babyagi/blob/fa8930ebe72a82e5ad57b356e7cbec96290e5bb2/README.md)
- [Current React agent entry](https://github.com/yoheinakajima/babyagi/blob/fa8930ebe72a82e5ad57b356e7cbec96290e5bb2/babyagi/functionz/packs/drafts/react_agent.py)
- [Current function execution, imports, and secret injection](https://github.com/yoheinakajima/babyagi/blob/fa8930ebe72a82e5ad57b356e7cbec96290e5bb2/babyagi/functionz/core/execution.py)
- [Current package declarations](https://github.com/yoheinakajima/babyagi/blob/fa8930ebe72a82e5ad57b356e7cbec96290e5bb2/pyproject.toml), [setup metadata](https://github.com/yoheinakajima/babyagi/blob/fa8930ebe72a82e5ad57b356e7cbec96290e5bb2/setup.py), and [manifest](https://github.com/yoheinakajima/babyagi/blob/fa8930ebe72a82e5ad57b356e7cbec96290e5bb2/MANIFEST.in)
- [PyPI release metadata](https://pypi.org/project/babyagi/0.1.4/)
- [Archived original task loop and its MIT license](https://github.com/yoheinakajima/babyagi_archive)
