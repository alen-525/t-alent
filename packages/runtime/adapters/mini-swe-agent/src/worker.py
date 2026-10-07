"""NDJSON bridge that delegates every agent step to the pinned mini-SWE-agent classes."""
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

_active_shells: set[int] = set()
_original_popen = subprocess.Popen
_event_output = sys.stdout


class _TrackedProcess:
    def __init__(self, process):
        self._process = process

    def __getattr__(self, name):
        return getattr(self._process, name)

    def __enter__(self):
        self._process.__enter__()
        return self

    def __exit__(self, *args):
        return self._process.__exit__(*args)

    def communicate(self, *args, **kwargs):
        try:
            return self._process.communicate(*args, **kwargs)
        finally:
            if self._process.poll() is not None:
                _active_shells.discard(self._process.pid)


def _tracked_popen(*args, **kwargs):
    process = _original_popen(*args, **kwargs)
    if kwargs.get("start_new_session"):
        _active_shells.add(process.pid)
    return _TrackedProcess(process)


# LocalEnvironment's own _run remains authoritative; track its isolated bash process
# so a host cancellation can terminate that command before interrupting DefaultAgent.
subprocess.Popen = _tracked_popen


def emit(event):
    _event_output.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
    _event_output.flush()


def redact(value, secrets):
    if isinstance(value, str):
        for secret in secrets:
            if secret:
                value = value.replace(secret, "[redacted]")
        return value
    if isinstance(value, list):
        return [redact(item, secrets) for item in value]
    if isinstance(value, tuple):
        return [redact(item, secrets) for item in value]
    if isinstance(value, dict):
        return {str(key): redact(item, secrets) for key, item in value.items()}
    return value


def request_cancel(_signum, _frame):
    for pid in tuple(_active_shells):
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            _active_shells.discard(pid)
    raise KeyboardInterrupt("cancelled by host")


if hasattr(signal, "SIGUSR1"):
    signal.signal(signal.SIGUSR1, request_cancel)
else:
    signal.signal(signal.SIGTERM, request_cancel)


def read_history(path):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, list) else []
    except FileNotFoundError:
        return []


def render_history(runs):
    rows = []
    for run in runs[-6:]:
        rows.append("Earlier user task:\n" + str(run.get("task", "")))
        for msg in run.get("messages", [])[-40:]:
            role = msg.get("role", "unknown")
            content = msg.get("content")
            if content:
                rows.append(f"{role}: {content}")
            extra = msg.get("extra") or {}
            actions = extra.get("actions") or []
            for action in actions:
                rows.append("bash action: " + str(action.get("command", "")))
        rows.append("--- end of earlier task ---")
    text = "\n".join(rows)
    return text[-100_000:]


def main():
    request = json.loads(sys.stdin.readline())
    state = Path(request["stateDir"])
    history_path = Path(request["historyPath"])
    trajectory_path = Path(request["trajectoryPath"])
    history_path.parent.mkdir(parents=True, exist_ok=True)
    prior_runs = read_history(history_path)
    # The model credential arrives over the private worker pipe, never in the
    # inherited environment that LocalEnvironment passes to shell commands.
    secrets = [request.get("apiKey", "")]
    emit({"type": "session", "sessionId": request["hostSessionKey"]})

    from minisweagent.agents.default import DefaultAgent
    from minisweagent.environments.local import LocalEnvironment
    from minisweagent.models.litellm_model import LitellmModel

    class EventAgent(DefaultAgent):
        def add_messages(self, *messages):
            result = super().add_messages(*messages)
            for msg in messages:
                role = msg.get("role")
                if role == "assistant":
                    actions = (msg.get("extra") or {}).get("actions") or []
                    for action in actions:
                        emit({"type": "tool-call", "name": "bash", "input": redact(action.get("command", ""), secrets), "callId": action.get("tool_call_id", "")})
                elif role == "tool":
                    extra = msg.get("extra") or {}
                    emit({"type": "tool-result", "name": "bash", "output": redact(extra.get("raw_output", msg.get("content", "")), secrets), "callId": msg.get("tool_call_id", ""), "status": "error" if extra.get("returncode", 0) else "success"})
            return result

        def serialize(self, *extra_dicts):
            return redact(super().serialize(*extra_dicts), secrets)

        def save(self, path, *extra_dicts):
            data = self.serialize(*extra_dicts)
            if path:
                path = Path(path)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
            return data

    profile = request["model"]
    model = LitellmModel(
        model_name=f"openai/{profile['model']}",
        model_kwargs={"api_base": profile["baseUrl"], "api_key": request["apiKey"]},
        cost_tracking="ignore_errors",
    )
    env = LocalEnvironment(cwd=request["workspace"], timeout=request.get("commandTimeoutSeconds", 30))
    instructions = "You are mini-SWE-agent, operating through the official DefaultAgent and LocalEnvironment. Use bash tool calls to inspect and change the repository. Do not claim edits you did not make. When the task is complete, run exactly `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` as a bash command, with no other command in that call."
    task = request["input"]
    context = render_history(prior_runs)
    if context:
        task = "Prior trajectory context (history only; do not repeat completed work unless needed):\n" + context + "\n\nNew user task:\n" + task
    agent = EventAgent(model, env, system_template=instructions, instance_template="Please solve this task:\n\n{{task}}", output_path=trajectory_path, cost_limit=request.get("costLimit", 3.0), step_limit=request.get("stepLimit", 0))
    status = "error"
    error_text = ""
    try:
        with _redirect_stdout(sys.stderr):
            result = agent.run(task)
        status = str(result.get("exit_status", ""))
        final = agent.messages[-1].get("content", "") if agent.messages else ""
        if final:
            emit({"type": "assistant-replace", "text": redact(str(final), secrets)})
        if status == "Submitted":
            emit({"type": "assistant-complete"})
        elif status:
            emit({"type": "error", "message": f"mini-SWE-agent finished with {status}"})
    except KeyboardInterrupt:
        status = "cancelled"
        emit({"type": "cancelled"})
    except BaseException as error:
        status = "error"
        error_text = redact(str(error), secrets)
        emit({"type": "error", "message": error_text or type(error).__name__})
    finally:
        data = agent.save(trajectory_path) if "agent" in locals() else {"messages": []}
        prior_runs.append({"task": redact(request["input"], secrets), "status": status, "messages": data.get("messages", [])})
        history_path.write_text(json.dumps(redact(prior_runs, secrets), ensure_ascii=False))


class _redirect_stdout:
    def __init__(self, target):
        self.target = target

    def __enter__(self):
        self.original = sys.stdout
        sys.stdout = self.target

    def __exit__(self, *_):
        sys.stdout = self.original


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        emit({"type": "error", "message": str(error)[:4000]})
        raise
