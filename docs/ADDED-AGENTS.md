# 新增原版 Agent 包

2026-10-05 至 2026-10-07 新增 Qwen Code、Kilo、Continue、Aider、OpenHands、mini-SWE-agent、Deep Agents、OpenClaw、Mistral Vibe、SWE-agent、Open Interpreter、Roo Code、nanobot、smolagents、Magentic-One、Hermes Agent、CrewAI，使已接入包达到 24 个。包继续采用 `agent-package.json` + `prompts/`，版本为 `0.2.0`，官方执行循环、依赖和许可证由框架原生适配器提供。完整扩充范围见 [Agent 接入清单](AGENT-CATALOG.md)，其余编程和通用 Agent 仍在继续接入。

| Agent | 固定官方运行时 | 模型协议 | 原版运行时验收 |
| --- | --- | --- | --- |
| [Qwen Code](../packages/runtime/adapters/qwen/README.md) | `@qwen-code/qwen-code@0.24.7` | Chat Completions | 原生读文件工具及结果回传、跨实例历史、活动请求取消、凭据扫描 |
| [Kilo](../packages/runtime/adapters/kilo/README.md) | `@kilocode/cli@7.8.3` | Chat Completions、Responses、Anthropic | 三种协议实际路由、原生读工具、跨实例历史、模型隔离、取消/恢复、失败、冲突项目配置及凭据扫描 |
| [Continue](../packages/runtime/adapters/continue/README.md) | `@continuedev/cli@1.5.47` | Chat Completions、Anthropic | Chat 原生 Read 工具及回传、跨实例历史、会话隔离、取消/恢复、401；Anthropic 完整工具往返尚未验收 |
| [Aider](../packages/runtime/adapters/aider/README.md) | `aider-chat==0.86.2` | Chat Completions | 原版文件上下文和 SEARCH/REPLACE 编辑、跨实例历史继续编辑、活动请求取消、401 以 exit 0 结束时仍归一为错误 |
| [OpenHands](../packages/runtime/adapters/openhands/README.md) | `openhands-sdk==1.51.0`、`openhands-tools==1.51.0` | Chat Completions | 原生 terminal 工具及结果回传、持久历史、模型隔离、SDK interrupt 取消/恢复、401 和凭据扫描 |
| [mini-SWE-agent](../packages/runtime/adapters/mini-swe-agent/README.md) | `mini-swe-agent==2.4.6` | Chat Completions | 原版 DefaultAgent 与本机 bash 观察回传、轨迹历史、模型隔离、取消/恢复、失败和凭据扫描 |
| [Deep Agents](../packages/runtime/adapters/deepagents/README.md) | `deepagents==0.7.21` | Chat Completions | SDK 原生文件读写、默认子 agent 工具可用、跨实例 SQLite checkpoint、模型隔离、活动请求取消/恢复、401 和凭据扫描 |
| [OpenClaw](../packages/runtime/adapters/openclaw/README.md) | `openclaw@2026.9.8` | Chat Completions、Responses、Anthropic | Chat 原生文件工具及回传、跨实例历史、模型隔离、活动请求取消/恢复、401 和凭据扫描；Responses/Anthropic 尚未完整工具往返验收 |
| [Mistral Vibe](../packages/runtime/adapters/mistral-vibe/README.md) | `mistral-vibe==2.25.8` | Chat Completions | 原生 shell 观察回传、跨进程 ACP 历史、模型隔离、原生取消/恢复、401、冲突项目配置、浏览器工具关闭、凭据扫描 |
| [SWE-agent](../packages/runtime/adapters/swe-agent/README.md) | GitHub v1.1.0 + `swe-rex==1.4.0` | Chat Completions | 原版 DefaultAgent、LocalDeployment bash 观察回传、轨迹上下文、模型隔离、取消/恢复、失败、凭据扫描；无需 Docker |
| [Open Interpreter](../packages/runtime/adapters/open-interpreter/README.md) | `open-interpreter==0.4.3`（历史 Python） | Chat Completions | 原生 Python 执行和文件读写、完整代码事件、跨实例完成历史恢复、模型原样路由、隔离、取消/恢复、401、浏览器阻断和凭据扫描 |
| [Roo Code](../packages/runtime/adapters/roo/README.md) | 官方 `cli-v0.1.17`（历史 CLI） | Chat Completions | 原生读写工具及观察回传、原生任务历史、完整路由隔离、取消/恢复、401、凭据回显脱敏；仓库已归档 |
| [nanobot](../packages/runtime/adapters/nanobot/README.md) | `nanobot-ai==0.3.5` | Chat Completions | 原生文件工具与模型往返、历史恢复、模型/工作区隔离、取消/恢复、401 和凭据扫描 |
| [smolagents](../packages/runtime/adapters/smolagents/README.md) | `smolagents==1.26.0` CodeAgent | Chat Completions | 原版 Python 动作执行、通过官方 Tool API 接入工作区文件工具、观察回传、原生消息历史、隔离、取消/恢复、401 |
| [Magentic-One](../packages/runtime/adapters/magentic-one/README.md) | AutoGen `0.7.5` | Chat Completions | 官方编排器、Coder→CodeExecutor 原生文件执行、观察回传、原生团队 save/load、隔离、取消/恢复、401、轮数耗尽错误 |
| [Hermes Agent](../packages/runtime/adapters/hermes/README.md) | GitHub `v2026.9.14`，Agent `0.21.3` | Chat Completions | 原版文件读写及观察回传、成功历史恢复、精确含斜杠模型 ID、隔离、取消/恢复、401 和历史凭据脱敏 |
| [CrewAI](../packages/runtime/adapters/crewai/README.md) | `crewai==1.15.23` + `crewai-tools==1.15.23` | Chat Completions | 官方 Crew/Agent/Task 和 FileReadTool/FileWriterTool、观察回传、历史上下文、隔离、取消/恢复、401、凭据回显扫描 |

这些验证用固定官方运行时连接本机模拟模型，不调用付费模型 API。适配器合同测试独立验证路由、取消时序、状态隔离、错误和释放，不能替代原版验证。

Aider 的首次运行询问会在 `--yes-always` 下自动打开发布说明。现已显式禁用发布说明、更新检查、GUI、浏览器及 Playwright，子进程浏览器入口也设置为无副作用程序；合同测试断言这些设置。后续查验资料使用独立 HTTP/检索环境，不操作用户浏览器。

Continue 原版 CLI 只输出最终文本；`--format json` 是让模型返回 JSON 的提示设置，不是原生事件协议。适配器从已保存的原生回合中提取工具消息，在完成后提供宿主事件。Aider 也不伪装成原生实时工具事件流。

OpenClaw 使用原版 `agent --local --json`，无需 Gateway 或消息渠道，其 CLI 返回最终结果而非 token 流。浏览器、UI、消息发送、定时任务、自动更新与遥测均已禁用。OpenHands 的原生工具预设关闭浏览器。Deep Agents 使用限定工作区的原生 FilesystemBackend 和默认子 agent；当前未启用需要 SandboxBackend 的 shell 工具。mini-SWE-agent 的原版 `run()` 每次重置消息，后续任务通过先前原生轨迹上下文继续，未伪装成 SDK checkpoint。

本轮整体验收：199 项通过，零失败、零跳过（宿主/编译器 32 项、CLI 16 项、适配器 151 项）；网页构建通过。24 份纯数据包已通过编译、来源版本、归档 SHA-256 和加载/释放校验。新增包另通过固定上游运行时的本机模型往返测试。

Aider 的 `config.files` 显式指定要加入原生上下文的工作区相对路径；它不会凭输入文本扫描全部工作区文件。运行时为独立 Python venv，安装脚本校验固定 PyPI wheel 的 SHA-256。各包的官方来源、提交/标签、发布完整性和许可证均记录在 `agent-sources/<id>/0.2.0.json`；Qwen 的 npm 元数据未标明许可证，完整官方 Apache-2.0 文本另从固定标签保存。

打包、校验和 `cli:all` / `host:all` 自动读取可信适配器注册表，避免新增包被固定数量列表遗漏。普通分发校验验证已注册包的结构、源码记录、编译缓存、校验值和加载/释放；外部 Python/二进制运行时需先按各包指南安装。

Open Interpreter 固定的是 AGPL-3.0-only 的历史 Python 0.4.3 发布物，未与当前 Rust CLI 的版本或许可证混同。SWE-agent 使用原生轨迹作为后续任务的历史上下文，并未宣称是 SDK 暂停点恢复。

Magentic-One 接入的是官方编程团队，未启用 WebSurfer/FileSurfer。CrewAI 当前包只提供官方文件工具，不运行命令或测试；历史续接是任务/结果上下文，不能当作 SDK 暂停点。smolagents 恢复原生消息和观察，Python 执行变量每轮重建。Hermes 安装固定提交中的官方直接依赖，传递依赖由安装时解析，不能宣称完整离线依赖锁。

已清除未引用的 Input/Switch 组件、旧截图和重复前端产物；私有运行时、会话及缓存保留，并统一忽略各层 `.talent/` 状态目录。四个未验收候选的证据与运行限制保留在接入清单及各自的 ASSESSMENT.md 中。
