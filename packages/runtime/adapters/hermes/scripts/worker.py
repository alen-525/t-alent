import json
import os
import sys
import tempfile
from pathlib import Path
import tomllib

VERSION = "0.21.3"


def emit(kind, **values):
    sys.__stdout__.write(json.dumps({"type": kind, **values}, ensure_ascii=False, default=str) + "\n")
    sys.__stdout__.flush()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".history-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, default=str)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def redact_history(value, secret):
    if isinstance(value, str):
        return value.replace(secret, "[redacted]")
    if isinstance(value, list):
        return [redact_history(item, secret) for item in value]
    if isinstance(value, dict):
        return {key: redact_history(item, secret) for key, item in value.items()}
    return value


def main(payload):
    source = Path(os.environ["TALENT_HERMES_SOURCE"])
    if not (source / "run_agent.py").is_file():
        raise RuntimeError("verified Hermes release source is missing")
    if tomllib.loads((source / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"] != VERSION:
        raise RuntimeError("Pinned Hermes source/runtime version mismatch")
    sys.path.insert(0, str(source))
    from run_agent import AIAgent

    key = os.environ.get("TALENT_HERMES_API_KEY")
    if not key:
        raise RuntimeError("selected model API key is missing from the isolated worker environment")
    # Hermes and optional CLI components print status/progress to stdout; reserve the
    # worker's real stdout for the adapter's machine-readable event stream.
    sys.stdout = sys.stderr
    history_file = Path(payload["profileDir"]) / "sessions" / (payload["sessionKey"] + ".json")
    history = []
    if history_file.exists():
        try:
            saved = json.loads(history_file.read_text(encoding="utf-8"))
            if not isinstance(saved, list):
                raise RuntimeError("saved Hermes conversation history is corrupt")
            history = saved
        except (OSError, ValueError):
            raise RuntimeError("saved Hermes conversation history is corrupt")

    def tool_start(call_id, name, arguments):
        emit("tool-call", callId=str(call_id), name=str(name), input=json.dumps(arguments, ensure_ascii=False, default=str))

    def tool_complete(call_id, name, arguments, result):
        output = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
        emit("tool-result", callId=str(call_id), name=str(name), output=output)

    # The allowlist is deliberately limited to Hermes' native coding shell and file tools.
    agent = AIAgent(
        base_url=payload["baseUrl"], api_key=key, provider="openai", api_mode="chat_completions",
        model=payload["model"], enabled_toolsets=["terminal", "file"],
        quiet_mode=True, platform="cli", session_id=payload["sessionKey"],
        skip_context_files=True, skip_memory=True, skip_background_review=True,
        tool_start_callback=tool_start, tool_complete_callback=tool_complete,
        max_iterations=30,
    )
    # Route through Hermes' first-party OpenAI-compatible client so no custom-provider
    # catalog/probe or persisted custom-provider configuration is required. Hermes normalizes
    # known provider/model aliases. The host model ID is authoritative,
    # including slash-bearing IDs, so restore it after route initialization; transport state
    # remains attached to the supplied base URL/key.
    agent.model = payload["model"]
    agent.tools = [tool for tool in (agent.tools or []) if tool.get("function", {}).get("name") not in {"tool_search", "tool_describe", "tool_call"}]
    agent.valid_tool_names = {tool["function"]["name"] for tool in agent.tools}
    emit("session", sessionId=payload["sessionKey"])
    try:
        result = agent.run_conversation(payload["input"], conversation_history=history, task_id=payload["taskId"])
        messages = result.get("messages") if isinstance(result, dict) else None
        if isinstance(result, dict) and result.get("interrupted"):
            emit("cancelled")
            return 0
        if isinstance(result, dict) and result.get("error"):
            emit("error", message=str(result["error"]))
            return 1
        if not isinstance(messages, list):
            raise RuntimeError("Hermes returned no native conversation history; preserving the last successful checkpoint")
        atomic_json(history_file, redact_history(messages, key))
        response = result.get("final_response", "") if isinstance(result, dict) else ""
        if isinstance(response, str) and response:
            emit("assistant-delta", text=response)
        emit("complete", historyMessages=len(messages))
        return 0
    finally:
        close = getattr(agent, "close", None)
        if callable(close):
            close()


try:
    raw = sys.stdin.readline()
    if not raw:
        raise RuntimeError("missing task payload")
    code = main(json.loads(raw))
    raise SystemExit(code)
except BaseException as error:
    if isinstance(error, (KeyboardInterrupt, SystemExit)):
        raise
    emit("error", message=f"{type(error).__name__}: {error}")
    raise SystemExit(1)
