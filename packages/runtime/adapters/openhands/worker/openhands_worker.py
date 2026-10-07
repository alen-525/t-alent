"""NDJSON bridge to the pinned OpenHands Software Agent SDK."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import traceback
import uuid


def write(record: dict) -> None:
    sys.stdout.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main() -> int:
    request = json.loads(sys.stdin.readline())
    from importlib.metadata import version
    expected_versions = {"openhands-sdk": "1.51.0", "openhands-tools": "1.51.0"}
    for distribution, expected in expected_versions.items():
        actual = version(distribution)
        if actual != expected:
            raise RuntimeError(f"Pinned OpenHands runtime mismatch for {distribution}: expected {expected}, found {actual}")
    from openhands.sdk import Agent, Conversation, LLM
    from openhands.sdk.event.llm_convertible.action import ActionEvent
    from openhands.sdk.event.llm_convertible.message import MessageEvent
    from openhands.sdk.event.llm_convertible.observation import AgentErrorEvent, ObservationEvent, UserRejectObservation
    from openhands.sdk.llm import content_to_str
    from openhands.tools.preset.default import get_default_tools
    from pydantic import SecretStr

    model = request["model"]
    api_key = os.environ.get("TALENT_OPENHANDS_MODEL_API_KEY")
    if not api_key:
        raise RuntimeError("OpenHands model credential is missing")
    model_name = model["model"]
    if not model_name.startswith("openai/"):
        model_name = "openai/" + model_name
    llm = LLM(
        model=model_name,
        api_key=SecretStr(api_key),
        base_url=model.get("baseUrl"),
        api_mode="chat",
        stream=False,
        num_retries=0,
        timeout=90,
        usage_id="talent-openhands",
    )
    agent = Agent(llm=llm, tools=get_default_tools(enable_browser=False))
    output_lock = threading.Lock()
    original_write = write

    def emit(record: dict) -> None:
        with output_lock:
            original_write(record)

    def on_event(event) -> None:
        raw = event.model_dump(mode="json", exclude_none=True)
        emit({"kind": "harness-event", "event": raw})
        if isinstance(event, ActionEvent):
            action = event.action
            inputs = action.model_dump(mode="json", exclude_none=True) if action is not None else event.tool_call.model_dump(mode="json", exclude_none=True)
            emit({"kind": "tool-call", "name": event.tool_name, "callId": str(event.tool_call_id), "input": inputs})
        elif isinstance(event, ObservationEvent):
            try:
                output = "".join(content_to_str(event.observation.to_llm_content))
            except Exception:
                output = str(event.observation)
            emit({"kind": "tool-result", "name": event.tool_name, "callId": str(event.tool_call_id), "status": "error" if getattr(event.observation, "is_error", False) else "success", "output": output})
        elif isinstance(event, UserRejectObservation):
            emit({"kind": "tool-result", "name": event.tool_name, "callId": str(event.tool_call_id), "status": "error", "output": event.rejection_reason})
        elif isinstance(event, MessageEvent) and event.source == "agent":
            text = "".join(content_to_str(event.llm_message.content))
            if text:
                emit({"kind": "assistant-delta", "text": text})
        elif isinstance(event, AgentErrorEvent):
            emit({"kind": "error", "message": event.error})

    conversation = Conversation(
        agent=agent,
        workspace=request["workspace"],
        persistence_dir=request["persistenceDir"],
        conversation_id=uuid.UUID(request["conversationId"]),
        callbacks=[on_event],
        delete_on_close=False,
        visualizer=None,
    )
    emit({"kind": "session", "sessionId": str(conversation.id)})
    cancelled = threading.Event()

    def read_commands() -> None:
        for line in sys.stdin:
            try:
                command = json.loads(line)
            except json.JSONDecodeError:
                continue
            if command.get("type") == "cancel":
                cancelled.set()
                conversation.interrupt()
                return

    threading.Thread(target=read_commands, name="talent-openhands-control", daemon=True).start()
    try:
        conversation.send_message(request["input"])
        asyncio.run(conversation.arun())
        status = getattr(conversation.state.execution_status, "value", str(conversation.state.execution_status))
        emit({"kind": "done", "status": status, "cancelled": cancelled.is_set()})
        return 0
    finally:
        conversation.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        message = str(exc) or type(exc).__name__
        try:
            write({"kind": "error", "message": message, "traceback": traceback.format_exc(limit=8)})
        except Exception:
            pass
        raise SystemExit(1)
