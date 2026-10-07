# 五个新增 Harness Agent 包

结构更新：现有 Agent 包均为 JSON + prompts/，旧 SDK/CLI 实现及许可资料位于 packages/runtime/adapters/，来源版本记录在 agent-sources/。分发现为纯数据 .tar.gz，通过 `npm run pack:agents` 与 `npm run verify:agents` 验证；不再把 Agent 包作为 npm workspace 安装。下述选型和原生运行时验收仍有效，详见 [Agent 包指南](AGENT-PACKAGES.md)。

2026-10-04，在 0.1 结构中新增 Pi、OpenCode、Gemini CLI、Goose、Cline 五个 npm workspace 适配包，和既有 Codex、DeepSeek 包共用通用宿主。每个包运行上游原版执行循环、提示词和工具，通过宿主统一的任务事件与生命周期接口接入。模型配置继续由宿主的独立模型目录提供。

## 选择与来源

| 新包 | 固定运行时 | 上游许可 | 接入方式 | 接受的模型协议 |
| --- | --- | --- | --- | --- |
| [Pi](../packages/runtime/adapters/pi/README.md) | `@mariozechner/pi-coding-agent@0.73.1` | MIT | 原版 `createAgentSession` SDK | Chat Completions、Responses、Anthropic、Google Generative AI |
| [OpenCode](../packages/runtime/adapters/opencode/README.md) | `opencode-ai@1.18.32` | MIT | 原版 `run --pure --format json` CLI | Chat Completions、Responses、Anthropic |
| [Gemini CLI](../packages/runtime/adapters/gemini/README.md) | `@google/gemini-cli@0.62.0` | Apache-2.0 | 原版 headless `stream-json` CLI | Google Generative AI |
| [Goose](../packages/runtime/adapters/goose/README.md) | Goose CLI `1.48.0` | Apache-2.0 | 原版 `run --output-format stream-json` CLI | Chat Completions |
| [Cline](../packages/runtime/adapters/cline/README.md) | `@cline/core@0.0.90` | Apache-2.0 | 独立 Node 工作进程内运行原版 `ClineCore` SDK | Chat Completions |

选择依据是明确的开源许可、可调用的 SDK 或结构化 CLI，以及原生工具和会话能力。五个包覆盖不同的执行与上下文实现，便于在同一宿主中比较 Harness 行为。曾评估 Aider，最终选择提供结构化 Core SDK 的 Cline。

上游资料和固定来源：

- Pi：[源码提交](https://github.com/badlogic/pi-mono/tree/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent)，`781152fc24841dc54b22284514604048ebe5e2c9`。该 npm scope 已弃用并迁移到 `@earendil-works`；本次包固定使用已验收的历史发布版本，未声称它是最新版本。
- OpenCode：[v1.18.32 发布](https://github.com/anomalyco/opencode/releases/tag/v1.18.32)、[provider 文档](https://opencode.ai/docs/providers/)，提交 `545f51d26cc39a907d2867492d498d9607ea5fa4`。
- Gemini CLI：[v0.62.0 发布](https://github.com/google-gemini/gemini-cli/releases/tag/v0.62.0)、[headless 文档](https://github.com/google-gemini/gemini-cli/blob/v0.62.0/docs/cli/headless.md)，提交 `b460678f3db508407554afd604cc9d6635becb2a`。
- Goose：[v1.48.0 发布](https://github.com/aaif-goose/goose/releases/tag/v1.48.0)，提交 `25021517f12cab87c94bed0874fe7d28168dc264`。项目由原 `block/goose` 地址迁移至 `aaif-goose/goose`。
- Cline：[Core SDK 文档](https://github.com/cline/cline/blob/main/docs/sdk/clinecore.mdx)、[模型配置文档](https://github.com/cline/cline/blob/main/docs/sdk/model-providers.mdx)、[Apache 许可证](https://github.com/cline/cline/blob/main/LICENSE)。该 npm 发布未暴露 source commit，以发布物 shasum `9c1ff222b054a8db35f38240decf005cee669881` 和完整 integrity 固定来源；记录在包 manifest 和第三方声明中。

每个适配器使用项目 MIT 许可证，并随包携带上游许可证文本和 `THIRD-PARTY-NOTICES.md`。直接 npm 依赖均锁定版本，项目锁文件记录其依赖树。单独安装 tarball 时仍需获取上游依赖；Goose CLI 通过单独安装脚本获取。

## 安装和运行

在项目根目录运行：

```sh
npm install
# 本机 macOS ARM64：安装固定 Goose CLI 到宿主给该包使用的状态目录
npm run setup:runtime --workspace packages/runtime/adapters/goose -- --state-dir "$PWD/.talent/goose"
# config/models.local.json 按 models.example.json 配置；API key 留在环境变量中
npm run host:all -- --models ./config/models.local.json --workspace "$PWD"
# 另开终端启动界面
npm run dev
# 生成五个新增包及两个已有包的 tarball
npm run pack:agents
```

Goose 的自动安装脚本目前支持 macOS ARM64，下载官方固定版本 archive，校验包内固定 SHA-256 和运行时版本。该 SHA-256 是本次从官方发布物取得的校验值，上游未发布独立 checksum manifest。其他平台需从官方发布中安装匹配的 `1.48.0` 二进制，设置 `GOOSE_BIN` 或包 `config.program`；包启动时仍会验证版本。

只加载单个新增包的例子：

```sh
npm run host -- --package ./packs/pi --models ./config/models.local.json --workspace "$PWD"
```

在另一个目录解压声明式分发包，再交给已安装依赖的 t-alent：

```sh
mkdir -p ./agent-pi
tar -xzf /absolute/path/t-alent/dist/packages/t-alent-agent-pi-0.2.0.tar.gz -C ./agent-pi
node /absolute/path/t-alent/packages/runtime/cli.mjs \
  --package ./agent-pi/package \
  --models ./models.json --workspace "$PWD"
```

每个包的 `agent-package.json` 包含 ID、包版本、协议能力、来源 Agent 版本及处理流程，归档另含 `prompts/`。原生 SDK/CLI、测试和许可文件由框架的适配器工作空间提供。复制包并改写流程或提示词不需要修改宿主；新增原生 Harness 则需要先实现并登记框架适配器。

## 模型和状态边界

模型 profile 必须包含 `id`、`provider`、`model`、`protocol`、`apiKeyEnv`，可选 `baseUrl`。模型型号没有包内默认值。密钥通过环境变量引用解析，不写进模型目录或任务启动 JSON。协议不兼容、缺少模型或缺少密钥时拒绝任务；更换型号、端点或凭据引用会隔离会话。

Pi 和 Cline 将 `provider` 用作描述标签，在内部生成独立 provider 或使用固定兼容协议 provider；其余包也按 `protocol` 选择实现。支持某种协议不保证每个模型支持工具或有相同上下文容量。Pi/Cline 提供通用模型元数据默认值：200,000 context tokens、8,192 output tokens；这些数值不是型号能力查询，使用者需核对目标服务限制。

| 包 | 跨任务状态 | 取消方式 | 实际验收范围 |
| --- | --- | --- | --- |
| Pi | 原生 SessionManager 文件及宿主会话索引；跨实例打开原 session | SDK `abort()`，等待任务结束 | Chat Completions 原生文件工具、回传、历史、隔离、取消/恢复、401；其他三个协议的 SDK 路由已实现，未做完整工具端到端验收 |
| OpenCode | 原生数据库与宿主 session ID 索引；跨实例 `--session` | 终止拥有的进程组，超时强制结束 | 三种协议真实请求；Chat 原生文件工具、回传、历史、隔离、取消/恢复、401 |
| Gemini CLI | 原生 `.gemini` 会话和宿主索引，按 profile 隔离 home | 终止拥有的进程组，超时强制结束 | Generative AI 原生文件工具、回传、历史、隔离、取消/恢复、401 |
| Goose | 原生 SQLite 会话，按 profile 隔离 config/data/state/cache | SIGINT 后结束剩余进程组 | Chat 原生 shell 工具、回传、跨实例历史、路由、取消/恢复、401 |
| Cline | 原生消息对象通过 `initialMessages` 导入下一任务；每个任务新建 Core session | SDK abort 并终止工作进程组 | Chat 原生文件工具、回传、跨实例 canonical history、隔离、取消/恢复、401 |

Cline SDK 在上游仍属实验接口；正在执行的工具、审批及 Core 会话控制状态不会跨任务恢复。其包禁用内置团队/子 Agent 功能，保留默认 coding tools 和系统提示词。Cline 的原始 hook audit 被禁用，精确的所选密钥回显在消息/压缩记录写盘前过滤。

所有包的事件和错误文本会过滤已知凭据值。原生会话、工具输出和日志仍可能包含工作区内容及用户主动输入的敏感信息，不应将它们当作普遍的敏感数据清洗器。Gemini 为保证外部模型路由，拒绝带 `.gemini/settings.json` 的工作区；本地环境文件加载关闭，系统及用户设置隔离。OpenCode 使用 `--pure` 并清除继承的路由覆盖变量。各包保留上游本地工具执行语义，工具权限来自运行宿主的用户；独立进程本身不提供操作系统沙箱。

## 验收与交付

本次验收环境：macOS ARM64、Node.js 26.7.0。`npm test` 共 66 项通过、零失败、零跳过，`npm run build` 通过。五种新 Harness 在旧适配包结构下均通过源码目录和独立 npm tarball 安装目录中的原生运行时验收；新版数据包另由通用编译器和分发验证覆盖。

真实运行时验收均使用固定官方 SDK/CLI 连接本地模拟 API，由模拟模型发出工具调用，然后检查原生工具输出确实进入下一次模型请求。没有调用付费模型 API。

```sh
npm test
npm run build
npm run smoke:mock --workspace packages/runtime/adapters/pi
npm run smoke:mock --workspace packages/runtime/adapters/opencode
npm run smoke:mock --workspace packages/runtime/adapters/gemini
GOOSE_BIN="$PWD/.talent/goose/goose-runtime/goose" npm run smoke:mock --workspace packages/runtime/adapters/goose
npm run smoke:mock --workspace packages/runtime/adapters/cline
npm run pack:agents
node scripts/verify-agent-packages.mjs --real-smoke
```

分发文件位于 `dist/packages/`，`SHA256SUMS` 包含全部七个声明式包的校验值。新版分发验收在独立临时目录解压并加载数据包，完成后自动清理。

宿主联合测试覆盖五个新增 manifest 的唯一性、实际适配器加载、模型校验、协议不兼容、凭据不暴露及卸载隔离。完整宿主测试需要允许监听本地回环端口。新版分发验收将七个数据归档解压到独立临时目录，校验来源记录、编译和适配器生命周期接口。

本次交付范围是五种原版 Harness 的可运行独立适配包。项目计划中的通用组合 SDK、任意替换上游内部执行循环和跨 Harness 原生状态转换仍按原计划推进；详见 [PLAN.md](PLAN.md)。
