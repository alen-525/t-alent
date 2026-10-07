"""NDJSON host adapter around Microsoft's native AutoGen Magentic-One team."""
import asyncio
import json
import os
import signal
import sys
from pathlib import Path

_events = sys.stdout
_token = None
_secrets = []


def redact(value):
    if isinstance(value, str):
        for secret in _secrets:
            if secret:
                value = value.replace(secret, "[redacted]")
        return value
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    return value


def emit(event):
    _events.write(json.dumps(redact(event), ensure_ascii=False, separators=(",", ":")) + "\n")
    _events.flush()


def cancel(_signum, _frame):
    if _token is not None:
        _token.cancel()


async def main(request):
    global _token
    api_key = os.environ.pop("TALENT_MAGENTIC_ONE_API_KEY", "")
    _secrets.append(api_key)
    sys.stdout = sys.stderr

    from autogen_core import CancellationToken
    from autogen_agentchat.agents import CodeExecutorAgent
    from autogen_agentchat.base import TaskResult
    from autogen_agentchat.teams import MagenticOneGroupChat
    from autogen_ext.agents.magentic_one import MagenticOneCoderAgent
    from autogen_ext.code_executors.local import LocalCommandLineCodeExecutor
    from autogen_ext.models.openai import OpenAIChatCompletionClient

    workspace = Path(request["workspace"]).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    profile = request["model"]
    model_client = OpenAIChatCompletionClient(
        model=profile["model"],
        api_key=api_key,
        base_url=profile["baseUrl"],
        model_info={
            "vision": False,
            "function_calling": True,
            "json_output": False,
            "family": "unknown",
            "structured_output": False,
        },
        max_retries=0,
    )
    executor = LocalCommandLineCodeExecutor(work_dir=workspace, timeout=60, cleanup_temp_files=True)
    coder = MagenticOneCoderAgent("Coder", model_client=model_client)
    terminal = CodeExecutorAgent("ComputerTerminal", code_executor=executor)
    team = MagenticOneGroupChat(
        [coder, terminal],
        model_client=model_client,
        max_turns=request.get("maxTurns", 24),
        emit_team_events=True,
    )
    state_path = Path(request["historyPath"])
    if state_path.exists():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            await team.load_state(state)
        except Exception as error:
            raise RuntimeError(f"Could not restore native Magentic-One team state: {error}") from error

    _token = CancellationToken()
    emit({"type": "session", "sessionId": request["hostSessionKey"]})
    result = None
    try:
        async for event in team.run_stream(task=request["input"], cancellation_token=_token):
            if isinstance(event, TaskResult):
                result = event
                continue
            source = getattr(event, "source", "")
            content = getattr(event, "content", "")
            if not isinstance(content, str):
                try:
                    content = json.dumps(content, ensure_ascii=False, default=str)
                except Exception:
                    content = str(content)
            emit({
                "type": "native-event",
                "className": type(event).__name__,
                "agent": str(source),
                "content": content,
            })
        if _token.is_cancelled():
            emit({"type": "cancelled"})
            return
        if not isinstance(result, TaskResult):
            raise RuntimeError("native Magentic-One stream ended without TaskResult")
        if (result.stop_reason or "").strip().lower().startswith("max rounds reached"):
            raise RuntimeError("native Magentic-One team reached its max-turn limit")
        state = await team.save_state()
        state_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp_path = state_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(redact(state), ensure_ascii=False), encoding="utf-8")
        os.chmod(temp_path, 0o600)
        temp_path.replace(state_path)
        final = ""
        if result.messages:
            message = result.messages[-1]
            final = getattr(message, "content", "")
            if not isinstance(final, str):
                final = json.dumps(final, ensure_ascii=False, default=str)
        emit({"type": "assistant-replace", "text": final})
        emit({"type": "assistant-complete"})
    finally:
        _token = None
        await model_client.close()


def signal_cancel(_signum, _frame):
    cancel(_signum, _frame)


if hasattr(signal, "SIGUSR1"):
    signal.signal(signal.SIGUSR1, signal_cancel)
else:
    signal.signal(signal.SIGTERM, signal_cancel)

if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.readline())
        asyncio.run(main(request))
    except BaseException as error:
        emit({"type": "error", "message": redact(f"{type(error).__name__}: {error}")[:8000]})
        if isinstance(error, (KeyboardInterrupt, asyncio.CancelledError)) or (_token is not None and _token.is_cancelled()):
            emit({"type": "cancelled"})
            raise SystemExit(130)
        raise
