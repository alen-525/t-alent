"""NDJSON adapter around the pinned upstream SWE-agent and SWE-ReX APIs."""
import json
import os
import signal
import shlex
import sys
import tempfile
from pathlib import Path

_event_output = sys.stdout
_cancelled = False


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


def cancel(_signum, _frame):
    global _cancelled
    _cancelled = True
    raise KeyboardInterrupt("cancelled by host")


if hasattr(signal, "SIGUSR1"):
    signal.signal(signal.SIGUSR1, cancel)
else:
    signal.signal(signal.SIGTERM, cancel)


def read_runs(path):
    try:
        value = json.loads(Path(path).read_text())
        return value if isinstance(value, list) else []
    except FileNotFoundError:
        return []


def render_history(runs):
    lines = []
    for run in runs[-5:]:
        lines.append("Earlier task: " + str(run.get("task", "")))
        for step in run.get("trajectory", [])[-25:]:
            if step.get("action"):
                lines.append("Earlier bash action: " + str(step["action"]))
            if step.get("observation"):
                lines.append("Earlier bash observation: " + str(step["observation"]))
        lines.append("--- end of earlier task ---")
    return "\n".join(lines)[-80_000:]


def main():
    request = json.loads(sys.stdin.readline())
    # Reserve stdout exclusively for host NDJSON before importing upstream code;
    # SWE-agent's loggers and config setup may print before its run loop starts.
    sys.stdout = sys.stderr
    api_key = request["apiKey"]
    secrets = [api_key]
    state_dir = Path(request["stateDir"])
    profile_dir = state_dir.parent
    (profile_dir / "trajectories").mkdir(parents=True, exist_ok=True)
    workspace = Path(request["workspace"]).resolve()
    virtual_root = state_dir / "swe-rex-local-root"
    virtual_root.mkdir(parents=True, exist_ok=True)
    os.environ["SWE_AGENT_CONFIG_ROOT"] = request["sourceDir"]
    os.environ["SWE_AGENT_CONFIG_DIR"] = str(Path(request["sourceDir"]) / "config")
    os.environ["SWE_AGENT_TOOLS_DIR"] = str(Path(request["sourceDir"]) / "tools")
    os.environ["SWE_AGENT_TRAJECTORY_DIR"] = str(profile_dir / "trajectories")

    from sweagent.agent.agents import DefaultAgent, DefaultAgentConfig
    from sweagent.agent.hooks.abstract import AbstractAgentHook
    from sweagent.agent.problem_statement import TextProblemStatement
    from sweagent.environment.swe_env import SWEEnv
    from swerex.deployment.config import LocalDeploymentConfig

    prior_runs = read_runs(request["historyPath"])
    task_text = request["input"]
    prior = render_history(prior_runs)
    if prior:
        task_text = "Previous SWE-agent trajectories for this host session:\n" + prior + "\n\nCurrent task:\n" + task_text

    class ScopedLocalEnv(SWEEnv):
        # SWE-agent's tool registry uses /root paths because its main deployment
        # is a container. With the official SWE-ReX LocalDeployment, redirect
        # those registry files into this worker's private state directory.
        def _scoped(self, path):
            p = Path(path)
            if p.is_absolute() and (str(p) == "/root" or str(p).startswith("/root/")):
                return virtual_root / str(p).removeprefix("/root/")
            return p

        def write_file(self, path, content):
            mapped = self._scoped(path)
            mapped.parent.mkdir(parents=True, exist_ok=True)
            mapped.write_text(content)

        def read_file(self, path, encoding=None, errors=None):
            return self._scoped(path).read_text(encoding=encoding, errors=errors)

    import yaml
    raw_config = yaml.safe_load(Path(request["defaultConfigPath"]).read_text())
    # The official DefaultAgent prompt/config stays authoritative. This host
    # adapter selects only the standard bash tool and native function parser;
    # default registry bundles target container-only /root/tools paths.
    raw_config["agent"]["tools"]["bundles"] = []
    raw_config["agent"]["tools"]["registry_variables"] = {}
    raw_config["agent"]["tools"]["env_variables"] = {"working_dir": str(workspace)}
    raw_config["agent"]["model"] = {
        "name": f"openai/{request['model']['model']}",
        "api_base": request["model"]["baseUrl"],
        "api_key": api_key,
        "per_instance_cost_limit": request.get("costLimit", 0.0),
        "total_cost_limit": request.get("costLimit", 0.0),
        "per_instance_call_limit": request.get("stepLimit", 0),
        "retry": {"retries": 1, "min_wait": 0, "max_wait": 0},
    }
    agent_config = DefaultAgentConfig.model_validate(raw_config["agent"])
    agent = DefaultAgent.from_config(agent_config)
    agent.tools.mock_state = {}
    event_id = 0

    class HostEvents(AbstractAgentHook):
        def on_actions_generated(self, *, step):
            nonlocal event_id
            event_id += 1
            emit({"type": "tool-call", "name": "bash", "callId": str(event_id), "input": redact(step.action, secrets)})

        def on_action_executed(self, *, step):
            emit({"type": "tool-result", "name": "bash", "callId": str(event_id), "output": redact(step.observation, secrets), "status": "unknown"})

        def on_step_done(self, *, step, info):
            if step.thought:
                emit({"type": "assistant-delta", "text": redact(step.thought, secrets)})

        def on_run_done(self, *, trajectory, info):
            return None

    agent.add_hook(HostEvents())
    env = ScopedLocalEnv(
        deployment=LocalDeploymentConfig().get_deployment(), repo=None,
        post_startup_commands=[], name="talent-local-swe-rex",
    )
    problem = TextProblemStatement(text=task_text)
    status = "error"
    result_data = {"trajectory": []}
    error_text = ""
    emit({"type": "session", "sessionId": request["hostSessionKey"]})
    try:
        # LocalDeployment launches SWE-ReX's persistent pexpect/bash runtime in
        # the worker's workspace cwd; no Docker client or container is used.
        env.start()
        env.communicate("cd " + shlex.quote(str(workspace)), check="raise")
        result = agent.run(env=env, problem_statement=problem, output_dir=state_dir / "native-trajectories")
        result_data = result.model_dump(mode="json")
        status = str(result.info.get("exit_status") or "completed")
        final = result.info.get("submission") or (result.trajectory[-1].get("thought", "") if result.trajectory else "")
        if final:
            emit({"type": "assistant-replace", "text": redact(str(final), secrets)})
        if isinstance(final, str) and final.startswith("Exit due to unknown error:"):
            status = "error"
            emit({"type": "error", "message": redact(final, secrets)})
        elif status in ("submitted", "exit_command"):
            emit({"type": "assistant-complete"})
        else:
            emit({"type": "error", "message": redact(f"SWE-agent ended with {status}", secrets)})
    except KeyboardInterrupt:
        status = "cancelled"
        emit({"type": "cancelled"})
        try:
            result_data = agent.get_trajectory_data()
        except Exception:
            pass
    except BaseException as error:
        status = "error"
        error_text = redact(str(error), secrets)
        emit({"type": "error", "message": error_text or type(error).__name__})
        try:
            result_data = agent.get_trajectory_data()
        except Exception:
            pass
    finally:
        try:
            env.close()
        except BaseException as error:
            if status != "cancelled":
                emit({"type": "error", "message": redact(f"SWE-ReX shutdown failed: {error}", secrets)})
        trajectory = result_data.get("trajectory", []) if isinstance(result_data, dict) else []
        prior_runs.append({"task": redact(request["input"], secrets), "status": status, "trajectory": trajectory})
        Path(request["historyPath"]).parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix="history-", suffix=".tmp", dir=state_dir)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(redact(prior_runs, secrets), handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, request["historyPath"])
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        emit({"type": "error", "message": str(error)[:4000]})
        raise
