## mini-SWE-agent 2.4.6

The adapter installs the official `mini-swe-agent` 2.4.6 PyPI wheel from the
fixed URL and SHA-256 in `agent-sources/mini-swe-agent/0.2.0.json`. Its upstream
license is MIT; the exact license distributed in that wheel is reproduced in
`LICENSE.mini-swe-agent`.

The wheel's Python dependencies are installed by pip into the adapter's private
virtual environment according to the wheel metadata. They are not vendored by
this adapter. Their individual licenses and metadata remain in that virtual
environment's installed distributions.
