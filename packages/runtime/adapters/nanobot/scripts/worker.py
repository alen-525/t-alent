import asyncio
import json
import os
import sys
from pathlib import Path

NANOBOT_VERSION = "0.3.5"
ALLOWED_TOOLS = {
    "read_file", "write_file", "edit_file", "list_dir", "find_files", "grep",
    "apply_patch", "exec", "exec_session", "list_exec_sessions",
}


def emit(event):
    sys.__stdout__.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.__stdout__.flush()


def write_runtime_config(payload):
    profile_dir = Path(payload["profileDir"])
    config_path = profile_dir / "config.json"
    api_key_env = "NANOBOT_HOST_API_KEY"
    data = {
        "agents": {"defaults": {"workspace": payload["workspace"], "model": "talent/" + payload["model"], "max_tool_iterations": 30}},
        "providers": {"talent": {
            "display_name": payload["provider"],
            "api_key": "${" + api_key_env + "}",
            "api_base": payload["baseUrl"],
        }},
        "tools": {
            "web": {"enable": False},
            "exec": {"enable": True, "allowed_env_keys": [], "timeout": 60},
            "file": {"enable": True},
            "cli_apps": {"enable": False},
            "my": {"enable": False},
            "image_generation": {"enabled": False},
            "mcp_servers": {},
            "restrict_to_workspace": True,
        },
    }
    temp = config_path.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.chmod(temp, 0o600)
    os.replace(temp, config_path)
    return config_path


async def main(payload):
    key = os.environ.get("NANOBOT_HOST_API_KEY")
    if not key:
        raise RuntimeError("selected model API key is missing from the isolated worker environment")
    try:
        import importlib.metadata as metadata
        if metadata.version("nanobot-ai") != NANOBOT_VERSION:
            raise RuntimeError(f"Nanobot runtime must be {NANOBOT_VERSION}")
        from nanobot import (
            STREAM_EVENT_RUN_COMPLETED,
            STREAM_EVENT_RUN_FAILED,
            STREAM_EVENT_TEXT_DELTA,
            STREAM_EVENT_TOOL_COMPLETED,
            STREAM_EVENT_TOOL_FAILED,
            STREAM_EVENT_TOOL_STARTED,
            Nanobot,
        )

        config_path = write_runtime_config(payload)
        session_key = "talent:" + payload["sessionKey"]
        emit({"type": "session", "sessionId": payload["sessionKey"]})
        async with Nanobot.from_config(config_path=config_path, workspace=payload["workspace"], model="talent/" + payload["model"]) as bot:
            # Nanobot keeps its own AgentLoop, runner, sessions, and first-party tools.
            # Restrict its published tool registry to the coding capabilities this host exposes.
            registry = bot._loop.tools
            for name in list(registry.tool_names):
                if name not in ALLOWED_TOOLS:
                    registry.unregister(name)
            if "exec" not in registry.tool_names or "read_file" not in registry.tool_names:
                raise RuntimeError("Nanobot native coding tools failed to initialize")
            async for event in bot.stream(payload["input"], session_key=session_key, channel="cli", chat_id="talent", sender_id="user"):
                kind = event.type
                if kind == STREAM_EVENT_TEXT_DELTA and event.delta:
                    emit({"type": "assistant-delta", "text": event.delta})
                elif kind == STREAM_EVENT_TOOL_STARTED:
                    emit({"type": "tool-call", "name": event.name or "tool", "input": json.dumps(event.arguments or {}, ensure_ascii=False), "callId": event.tool_call_id or ""})
                elif kind in (STREAM_EVENT_TOOL_COMPLETED, STREAM_EVENT_TOOL_FAILED):
                    metadata_value = event.metadata if isinstance(event.metadata, dict) else {}
                    result = metadata_value.get("result")
                    if result is None and event.error:
                        result = event.error
                    if isinstance(result, str):
                        output = result
                    else:
                        output = json.dumps(result, ensure_ascii=False, default=str) if result is not None else ""
                    emit({"type": "tool-result", "name": event.name or "tool", "output": output, "callId": event.tool_call_id or "", "status": "error" if kind == STREAM_EVENT_TOOL_FAILED else "ok", "metadata": metadata_value})
                elif kind == STREAM_EVENT_RUN_COMPLETED:
                    run_error = getattr(event.result, "error", None) if event.result is not None else None
                    if run_error:
                        emit({"type": "error", "message": str(run_error)})
                    else:
                        emit({"type": "complete"})
                elif kind == STREAM_EVENT_RUN_FAILED:
                    emit({"type": "error", "message": event.error or "Nanobot run failed"})
                    return
    finally:
        pass


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
