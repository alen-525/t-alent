import json, os, sys, traceback
from pathlib import Path

_secret = ""

def redact(value):
    if isinstance(value, str): return value.replace(_secret, "[redacted]") if _secret else value
    if isinstance(value, list): return [redact(v) for v in value]
    if isinstance(value, dict): return {redact(k): redact(v) for k, v in value.items()}
    return value

def emit(event):
    sys.stdout.write(json.dumps(redact(event), ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def main(req):
    from crewai import Agent, Crew, LLM, Process, Task
    from crewai_tools import FileReadTool, FileWriterTool
    import uuid
    class ObservedFileReadTool(FileReadTool):
        def _run(self, *args, **kwargs):
            call_id=str(uuid.uuid4()); emit({"type":"tool-call","name":self.name,"callId":call_id,"input":str(kwargs)[:4000]})
            out=super()._run(*args, **kwargs); emit({"type":"tool-result","name":self.name,"callId":call_id,"output":str(out)[:8000]}); return out
    class ObservedFileWriterTool(FileWriterTool):
        def _run(self, *args, **kwargs):
            call_id=str(uuid.uuid4()); emit({"type":"tool-call","name":self.name,"callId":call_id,"input":str({k:("[content omitted]" if k=="content" else v) for k,v in kwargs.items()})[:4000]})
            out=super()._run(*args, **kwargs); emit({"type":"tool-result","name":self.name,"callId":call_id,"output":str(out)[:8000]}); return out
    root = str(Path(req["workspace"]).resolve())
    global _secret
    key = os.environ.pop("TALENT_CREWAI_API_KEY")
    _secret = key
    model = req["model"]
    llm = LLM(model="openai/" + model["model"], base_url=model["baseUrl"], api_key=key)
    reader = ObservedFileReadTool(base_dir=root)
    writer = ObservedFileWriterTool(base_dir=root)
    context = req.get("priorContext", "")
    task_text = req["input"]
    if context:
        task_text += "\n\nPrior session task context (continuity summary):\n" + context
    agent = Agent(
        role="Coding assistant", goal="Inspect and safely update files in the supplied workspace to satisfy the task.",
        backstory="You are a careful coding agent. Use the provided native file tools; do not claim to run commands or tests.",
        tools=[reader, writer], llm=llm, verbose=False, allow_delegation=False,
    )
    task = Task(description=task_text, expected_output="A concise report of files inspected or changed and any limitations.", agent=agent)
    crew = Crew(agents=[agent], tasks=[task], process=Process.sequential, verbose=False, memory=False)
    result = crew.kickoff()
    output = str(getattr(result, "raw", result))
    emit({"type":"assistant-delta", "text":output})
    state = redact({"scope":Path(req["historyPath"]).parent.name,"context":(context + "\nTask: " + req["input"] + "\nResult: " + output)[-24000:]})
    p=Path(req["historyPath"]);p.parent.mkdir(parents=True,exist_ok=True)
    temp=p.with_suffix(".tmp");temp.write_text(json.dumps(state),encoding="utf8");os.chmod(temp,0o600);temp.replace(p)
    emit({"type":"assistant-complete"})

if __name__ == "__main__":
    try: main(json.loads(sys.stdin.readline()))
    except BaseException as e:
        emit({"type":"error","message":redact(str(e)[:2000])})
        sys.exit(1)
