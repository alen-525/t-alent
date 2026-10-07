import asyncio
import contextlib
import io
import json
import os
import sys
import tempfile
import webbrowser

from interpreter.core.core import OpenInterpreter
from interpreter.core.computer.terminal.languages.python import Python
from interpreter.core.computer.terminal.languages.shell import Shell


def emit(event):
    sys.__stdout__.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.__stdout__.flush()


def block_browser(*_args, **_kwargs):
    raise RuntimeError("browser access is disabled in the Open Interpreter adapter")


def make_interpreter(payload, key):
    webbrowser.open = block_browser
    webbrowser.open_new = block_browser
    webbrowser.open_new_tab = block_browser
    agent = OpenInterpreter(
        messages=payload.get("history", []),
        auto_run=True,
        disable_telemetry=True,
        conversation_history=False,
        in_terminal_interface=False,
        os=False,
        import_computer_api=False,
        import_skills=False,
        system_message=(
            "You are Open Interpreter, an autonomous coding agent. Use Python or shell code "
            "to inspect and modify files in the current workspace, then report observed results. "
            "Do not use browser, GUI, desktop, or credential-management operations."
        ),
    )
    agent.computer.terminal.languages = [Python, Shell]
    # The upstream Computer API advertises browser, GUI, calendar and messaging actions.
    # Do not expose those tools to the model; only its original Python/shell code loop remains.
    agent.computer.system_message = ""
    agent.llm.model = "openai/" + payload["model"]
    agent.llm.api_base = payload["baseUrl"]
    agent.llm.api_key = key
    agent.llm.supports_functions = False
    agent.llm.supports_vision = False
    agent.llm.context_window = payload.get("contextWindow", 8192)
    agent.llm.max_tokens = payload.get("maxTokens", 2048)
    agent.computer.import_computer_api = False
    agent.computer.import_skills = False
    agent.offline = False
    return agent


def save_history(path, messages):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix="history-", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(messages, handle, ensure_ascii=False, default=str)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)


async def main(payload):
    key = os.environ.get(payload["apiKeyEnv"])
    if not key:
        raise RuntimeError("selected model API key is missing from the isolated worker environment")
    try:
        with open(payload["historyPath"], "r", encoding="utf-8") as handle:
            history = json.load(handle)
        if not isinstance(history, list):
            raise ValueError("history must be an array")
    except FileNotFoundError:
        history = []
    payload["history"] = history
    agent = make_interpreter(payload, key)
    emit({"type": "session", "sessionId": payload["sessionKey"]})
    code_count = 0
    code_block = None
    console_block = None
    with contextlib.redirect_stdout(io.StringIO()):
        for chunk in agent.chat(payload["input"], display=False, stream=True):
            role = chunk.get("role")
            kind = chunk.get("type")
            content = chunk.get("content", "")
            if role == "assistant" and kind == "code":
                if chunk.get("start"):
                    code_block = {"name": chunk.get("format", "python"), "parts": []}
                if code_block is None:
                    code_block = {"name": chunk.get("format", "python"), "parts": []}
                if isinstance(content, str) and content:
                    code_block["parts"].append(content)
                if chunk.get("end") and code_block is not None:
                    code_count += 1
                    emit({"type": "tool-call", "name": code_block["name"], "input": "".join(code_block["parts"]), "callId": str(code_count)})
                    code_block = None
            elif role == "computer" and kind == "console":
                if chunk.get("start"):
                    console_block = {"parts": [], "formats": []}
                if console_block is None:
                    console_block = {"parts": [], "formats": []}
                if isinstance(content, str) and content:
                    console_block["parts"].append(content)
                    fmt = chunk.get("format")
                    if isinstance(fmt, str) and fmt not in console_block["formats"]:
                        console_block["formats"].append(fmt)
                if chunk.get("end") and console_block is not None:
                    event = {"type": "tool-result", "name": "console", "output": "".join(console_block["parts"]), "metadata": {"formats": console_block["formats"]}}
                    if len(console_block["formats"]) == 1:
                        event["format"] = console_block["formats"][0]
                    emit(event)
                    console_block = None
            elif role == "assistant" and kind == "message" and isinstance(content, str) and content:
                emit({"type": "assistant-delta", "text": content})
    save_history(payload["historyPath"], agent.messages)
    emit({"type": "complete"})


try:
    line = sys.stdin.readline()
    if not line:
        raise RuntimeError("missing task payload")
    asyncio.run(main(json.loads(line)))
except BaseException as error:
    if isinstance(error, (KeyboardInterrupt, SystemExit)):
        raise
    emit({"type": "error", "message": f"{type(error).__name__}: {error}"})
    sys.exit(1)
