import asyncio
import json
import os
import sys
import traceback

from deepagents import create_deep_agent
from deepagents.backends.filesystem import FilesystemBackend
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver


def emit(event):
    sys.stdout.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
    sys.stdout.flush()


def message_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in content)
    return ""


async def main(payload):
    api_key = os.environ.get(payload["apiKeyEnv"])
    if not api_key:
        raise RuntimeError("the selected model API key is missing from the isolated worker environment")
    model = ChatOpenAI(
        model=payload["model"],
        api_key=api_key,
        base_url=payload["baseUrl"],
        max_retries=0,
        streaming=False,
    )
    backend = FilesystemBackend(root_dir=payload["workspace"], virtual_mode=True)
    async with AsyncSqliteSaver.from_conn_string(payload["dbPath"]) as checkpointer:
        await checkpointer.setup()
        agent = create_deep_agent(
            model=model,
            backend=backend,
            checkpointer=checkpointer,
            system_prompt=payload["systemPrompt"],
        )
        config = {"configurable": {"thread_id": payload["threadId"]}}
        async for event in agent.astream_events(
            {"messages": [{"role": "user", "content": payload["input"]}]},
            config=config,
            version="v2",
        ):
            kind = event.get("event")
            data = event.get("data", {})
            if kind == "on_chat_model_stream":
                chunk = data.get("chunk")
                content = message_text(getattr(chunk, "content", ""))
                if content:
                    emit({"type": "assistant-delta", "text": content})
            elif kind == "on_chat_model_end":
                output = data.get("output")
                content = message_text(getattr(output, "content", ""))
                if content:
                    emit({"type": "assistant-delta", "text": content})
            elif kind == "on_tool_start":
                emit({"type": "tool-call", "name": event.get("name", "tool"), "input": data.get("input", {}), "callId": event.get("run_id")})
            elif kind == "on_tool_end":
                output = data.get("output", "")
                content = getattr(output, "content", output)
                emit({"type": "tool-result", "name": event.get("name", "tool"), "output": message_text(content) if not isinstance(content, str) else content, "status": "success", "callId": event.get("run_id")})
            elif kind == "on_tool_error":
                emit({"type": "tool-result", "name": event.get("name", "tool"), "output": str(data.get("error", "tool failed")), "status": "error", "callId": event.get("run_id")})
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
