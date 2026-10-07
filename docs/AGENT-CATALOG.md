# 开源 Agent 接入清单

目标：将常用开源 Agent 接入 t-alent 的 JSON + prompts 包，优先完成编程 Agent，再覆盖通用、多 Agent 和自动化项目。此清单用于追踪完整范围；“待接入”不表示已有可运行包，已有包也不构成全部范围。

核验日期：2026-10-07。以项目官方仓库、开源许可、发布物和可运行 Agent 入口为依据。对停止维护但仍常用的开源项目保留接入候选；单纯的框架库需先确定其官方 Agent 实现。实际版本和分发完整性由 `agent-sources/` 的记录固定。

## 编程 Agent

| 项目 | 官方来源 | 接入状态 |
| --- | --- | --- |
| Codex | [openai/codex](https://github.com/openai/codex) | 已接入 |
| DeepSeek Harness | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/DeepSeek-Harness) | 已接入 |
| Pi | [badlogic/pi-mono](https://github.com/badlogic/pi-mono) | 已接入固定历史发布 |
| OpenCode | [anomalyco/opencode](https://github.com/anomalyco/opencode) | 已接入 |
| Gemini CLI | [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli) | 已接入 |
| Goose | [aaif-goose/goose](https://github.com/aaif-goose/goose) | 已接入 |
| Cline | [cline/cline](https://github.com/cline/cline) | 已接入 Core SDK |
| Qwen Code | [QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) | 已接入并通过原版运行时验收 |
| Kilo | [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode) | 已接入并通过原版运行时验收 |
| Continue | [continuedev/continue](https://github.com/continuedev/continue) | 已接入并通过原版运行时验收 |
| Aider | [Aider-AI/aider](https://github.com/Aider-AI/aider) | 已接入并通过原版运行时验收 |
| OpenHands | [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | 已接入并通过原版运行时验收 |
| SWE-agent | [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) | 已接入并通过原版运行时验收 |
| mini-SWE-agent | [SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | 已接入并通过原版运行时验收 |
| Roo Code | [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code) | 已接入历史 CLI 0.1.17，并通过原版验收；上游仓库已归档 |
| Deep Agents | [langchain-ai/deepagents](https://github.com/langchain-ai/deepagents) | 已接入并通过原版运行时验收 |
| Mistral Vibe | [mistralai/mistral-vibe](https://github.com/mistralai/mistral-vibe) | 已接入并通过原版运行时验收 |
| OpenAI Symphony | [openai/symphony](https://github.com/openai/symphony) | v0.0.3 发布物已核验；实际调度、模型路由仍未验收，见 [记录](../agent-sources/symphony/ASSESSMENT.md) |

## 通用、多 Agent 与自动化

此表同时记录已接入项目和未验收候选。未验收项目还需解决固定版本、许可、独立运行或模型路由问题。

| 项目 | 官方来源 | 接入状态 |
| --- | --- | --- |
| Open Interpreter | [OpenInterpreter/open-interpreter](https://github.com/OpenInterpreter/open-interpreter) | 已接入历史 Python 0.4.3，当前 Rust CLI 另待核验 |
| Magentic-One | [microsoft/autogen](https://github.com/microsoft/autogen) | 已接入官方 Magentic-One 编程团队，并通过原版运行时验收 |
| OpenClaw | [openclaw/openclaw](https://github.com/openclaw/openclaw) | 已接入并通过原版运行时验收 |
| nanobot | [HKUDS/nanobot](https://github.com/HKUDS/nanobot) | 已接入并通过原版运行时验收 |
| Hermes Agent | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 已接入并通过原版运行时验收 |
| Agent Zero | [agent0ai/agent-zero](https://github.com/agent0ai/agent-zero) | 当前环境缺少官方 Docker 运行条件，见 [记录](../agent-sources/agent-zero/ASSESSMENT.md) |
| AutoGPT | [Significant-Gravitas/AutoGPT](https://github.com/Significant-Gravitas/AutoGPT) | Classic 与当前平台已区分；运行条件和历史版本问题仍待解决，见 [记录](../agent-sources/autogpt/ASSESSMENT.md) |
| BabyAGI | [yoheinakajima/babyagi](https://github.com/yoheinakajima/babyagi) | 模型路由、嵌入协议及来源许可问题待解决，见 [记录](../agent-sources/babyagi/ASSESSMENT.md) |
| smolagents | [huggingface/smolagents](https://github.com/huggingface/smolagents) | 已接入原版 CodeAgent，并通过文件工具和原生代码执行验收 |
| CrewAI | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 已接入官方 Crew/Agent/Task 和文件工具，并通过原版运行时验收 |

## 验收标准

每个接入项目必须提供纯数据包、框架原生适配器、固定上游版本及许可记录、独立模型配置、会话策略、取消/释放、错误处理与有针对性的测试。验收要驱动固定官方运行时连接本地模拟模型，证明其原生工具或动作实际执行，并把结果传回模型；模拟进程测试不能替代这项证据。

工具事件有原生实时协议时直接映射；只有文本或历史记录时明确注明事件产生时机，不伪造实时工具流。原版运行时不兼容某协议时不宣称完全适配。不同原生会话不能直接混用。

尚未完成全部候选接入，因此整个目标保持进行中。新增查证的常用项目继续补入清单，不能通过移除困难候选把未完成目标标记为完成。
