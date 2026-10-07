# Third-party notices

This adapter imports the separately installed upstream `open-interpreter==0.4.3` distribution at runtime. It does not vendor or copy the upstream executable/package code into the declarative recipe. The upstream 0.4.3 wheel's license file identifies GNU Affero General Public License version 3; its full license text is retained as `LICENSE.open-interpreter`.

Official distribution: https://pypi.org/project/open-interpreter/0.4.3/

Wheel SHA-256: `bb694b826b11986a305b7d34acbabae830481bb1180b52fe1b912e882a21b590`.

The setup also pins setuptools 80.9.0 (`062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922`) because this legacy runtime imports `pkg_resources`, which is absent from current setuptools releases.

The PyPI release is from 2024 and is a legacy Python runtime. The current repository has moved on to a Rust CLI line; this adapter does not claim to package or represent that CLI.
