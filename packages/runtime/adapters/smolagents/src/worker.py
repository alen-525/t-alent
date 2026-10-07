"""NDJSON host adapter around the pinned native smolagents CodeAgent loop."""
import json
import os
import signal
import sys
from pathlib import Path

_events = sys.stdout
_secrets = []


def emit(event):
    _events.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    _events.flush()


def redact(value, secrets):
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[redacted]")
        return value
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, dict):
        return {key: redact(item, secrets) for key, item in value.items()}
    return value


def within_workspace(root, value):
    candidate = (root / value).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError("file path must stay inside the task workspace") from error
    return candidate


def main():
    global _secrets
    request = json.loads(sys.stdin.readline())
    sys.stdout = sys.stderr
    api_key = os.environ.pop("TALENT_SMOLAGENTS_API_KEY", "")
    secrets = [api_key] if api_key else []
    _secrets = secrets
    workspace = Path(request["workspace"]).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    history_path = Path(request["historyPath"])
    try:
        history = json.loads(history_path.read_text(encoding="utf-8"))
        if not isinstance(history, dict):
            raise ValueError("history document must be an object")
    except FileNotFoundError:
        history = {"runs": [], "conversationMessages": []}
    except Exception as error:
        raise RuntimeError(f"Could not load native CodeAgent history: {error}") from error

    from smolagents import CodeAgent, OpenAIServerModel, Tool
    from smolagents.memory import MemoryStep
    from smolagents.models import ChatMessage
    from smolagents.monitoring import LogLevel

    class ReadFileTool(Tool):
        name = "read_file"
        description = "Read a UTF-8 text file from the task workspace."
        inputs = {"path": {"type": "string", "description": "Workspace-relative file path"}}
        output_type = "string"

        def forward(self, path):
            return within_workspace(workspace, path).read_text(encoding="utf-8")

    class WriteFileTool(Tool):
        name = "write_file"
        description = "Write UTF-8 text to a file in the task workspace."
        inputs = {
            "path": {"type": "string", "description": "Workspace-relative file path"},
            "content": {"type": "string", "description": "File contents"},
        }
        output_type = "string"

        def forward(self, path, content):
            target = within_workspace(workspace, path)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            return f"Wrote {target.relative_to(workspace)}"

    class PersistedMessages(MemoryStep):
        def __init__(self, messages):
            self.messages = [ChatMessage.from_dict(dict(message)) for message in messages]

        def dict(self):
            return {"persisted_conversation_messages": [json.loads(message.model_dump_json()) for message in self.messages]}

        def to_messages(self, summary_mode=False):
            return [] if summary_mode else self.messages

    previous_messages = history.get("conversationMessages", [])
    if not isinstance(previous_messages, list):
        raise RuntimeError("Invalid native CodeAgent conversation messages")
    profile = request["model"]
    model = OpenAIServerModel(
        model_id=profile["model"],
        api_base=profile["baseUrl"],
        api_key=api_key,
        client_kwargs={"max_retries": 0},
    )
    call_number = 0

    def on_action_step(step, agent):
        nonlocal call_number
        if not step.code_action:
            return
        call_number += 1
        call_id = str(call_number)
        emit({"type": "tool-call", "name": "python_interpreter", "callId": call_id, "input": redact(step.code_action, secrets)})
        emit({"type": "tool-result", "name": "python_interpreter", "callId": call_id, "output": redact(str(step.observations or ""), secrets), "status": "success" if step.error is None else "error"})

    agent = CodeAgent(
        tools=[ReadFileTool(), WriteFileTool()],
        model=model,
        add_base_tools=False,
        additional_authorized_imports=[],
        max_steps=request.get("maxSteps", 12),
        verbosity_level=LogLevel.ERROR,
        step_callbacks=[on_action_step],
        return_full_result=True,
    )
    agent.memory.steps.append(PersistedMessages(previous_messages))
    before = len(agent.memory.steps)
    status = "error"
    output = None
    run_steps = []
    emit({"type": "session", "sessionId": request["hostSessionKey"]})
    try:
        result = agent.run(request["input"], reset=False, max_steps=request.get("maxSteps", 12), return_full_result=True)
        output = result.output
        status = str(result.state)
        run_steps = result.steps[before:]
        if status == "success":
            emit({"type": "assistant-replace", "text": redact(str(output), secrets)})
            emit({"type": "assistant-complete"})
        else:
            emit({"type": "error", "message": f"smolagents CodeAgent ended with state {status}"})
    except KeyboardInterrupt:
        status = "cancelled"
        run_steps = [step.dict() for step in agent.memory.steps[before:]]
        emit({"type": "cancelled"})
    except BaseException as error:
        status = "error"
        run_steps = [step.dict() for step in agent.memory.steps[before:]]
        emit({"type": "error", "message": redact(f"{type(error).__name__}: {error}", secrets)[:8000]})
    finally:
        try:
            agent.cleanup()
        except BaseException as error:
            if status != "cancelled":
                status = "error"
                emit({"type": "error", "message": redact(f"CodeAgent cleanup failed: {error}", secrets)[:4000]})
        new_messages = []
        for step in agent.memory.steps[before:]:
            try:
                new_messages.extend(json.loads(message.model_dump_json()) for message in step.to_messages())
            except Exception:
                continue
        history.setdefault("runs", []).append({"task": request["input"], "status": status, "output": output, "steps": run_steps})
        history["conversationMessages"] = redact(previous_messages + new_messages, secrets)
        history_path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = history_path.with_suffix(".tmp")
        temp_path.write_text(json.dumps(redact(history, secrets), ensure_ascii=False), encoding="utf-8")
        os.chmod(temp_path, 0o600)
        temp_path.replace(history_path)


_cancelled = False


def cancel(_signum, _frame):
    global _cancelled
    _cancelled = True
    raise KeyboardInterrupt("cancelled by host")


if hasattr(signal, "SIGUSR1"):
    signal.signal(signal.SIGUSR1, cancel)
else:
    signal.signal(signal.SIGTERM, cancel)

if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        emit({"type": "error", "message": redact(f"{type(error).__name__}: {error}", _secrets)[:4000]})
        raise
