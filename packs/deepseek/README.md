# DeepSeek Agent 包

此包通过 DeepSeek 官方 `@deepseek-ai/dsh` 命令运行原版 `headless` profile。每个任务由原版 Harness 创建 Agent、执行完整循环并调用其原有文件与工具权限；适配层只负责启动进程、投影 JSON 事件和管理会话生命周期。

## 使用

要求 Node.js 22 或更新版本。宿主应在服务端安装包，并通过 `createAgentPackage` 创建一个实例：

```js
import { createAgentPackage } from '@t-alent/agent-deepseek'

const agent = await createAgentPackage({
  workspace: '/srv/workspaces/project',
  stateDir: '/srv/state/project',
  env: process.env,
  config: { model: 'deepseek-flash' },
})
const abortController = new AbortController()

try {
  const events = agent.executeTask(
    { taskId: 'task-42', input: '检查这个项目', sessionId: 'conversation-9' },
    { signal: abortController.signal },
  )
  for await (const event of events) console.log(event)
} finally {
  await agent.dispose()
}
```

`DEEPSEEK_API_KEY` 由服务端环境提供，凭据不会放入包清单、生成的模型配置文件或返回事件。可用 `DEEPSEEK_BASE_URL` 指向兼容 Messages API 的服务。缺少密钥时，原 Harness 会返回错误。通过 `await agent.listModels()` 获取固定官方 DSH 版本公布的模型目录、默认模型和 `allowCustomModel` 能力；目录直接读取 `@deepseek-ai/dsh-llm-deepseek@0.2.0-rc.2`，不在适配层维护模型 ID。当前上游目录含 `deepseek-flash` 和 `deepseek-v4-pro`，原版 provider 也会把未列出的自定义模型 ID 当作纯文本路由透传。`DEEPSEEK_MODEL` 提供模型默认值，`config.model` 优先；不带自定义 patch 时，`defaultModel` 反映这项配置，若有调用方 patch 则省略该字段，因为 patch 可能改写默认模型。任务可通过 `executeTask({ model })` 选择模型；它会去除首尾空白并要求 1–200 个字符，且优先于 `config.model`、`DEEPSEEK_MODEL` 及调用方 patch 中的默认模型。没有任务级选择时，`config.reasoningEffort`、`config.maxTokens` 和 `config.patches` 可覆盖推理强度、输出上限和 Cordis 配置，调用方 patch 按数组顺序应用。

Harness home 固定在 `stateDir/dsh`。`stateDir/deepseek-sessions.json` 保存宿主 `sessionId`（缺省时为 `taskId`）到原版 Session id 的映射；使用相同宿主会话 id 时，原版 headless 会恢复持久历史。取消会先向原版 CLI 发送 SIGINT 并等待退出与 session 落盘，最多等待 7 秒，随后才使用 SIGKILL。`config.cancelGraceMs` 可将宽限期设为 1–60,000 毫秒。取消期间迟到的输出会被丢弃；任务结束后可以用相同会话 id 继续运行。

如果 npm 11 在安装时跳过了 `node-pty` 所需的 spawn-helper 构建脚本，可在官方 DSH 安装目录执行 `node node_modules/@deepseek-ai/dsh-subprocess-local/scripts/ensure-spawn-helper.mjs`，生成原版运行时需要的 helper 文件。

任务事件来自原版 `--json` NDJSON 投影。已提交的 `text` 会生成 `assistant-delta`，`final` 会生成无损的 `assistant-replace`；原版对中间字符串有 8 KiB 限制，因此宿主应使用最终替换事件展示完整答案。`thinking` 映射为 `reasoning`，工具事件映射为 `tool-call`/`tool-result`，status 以 `harness-event` 提供。只有退出码为 0、存在 `final` 且 `turn_end.reason.kind` 为 `completed` 时才发送 `assistant-complete`。错误只发送一次 `error`，取消只发送 `cancelled`。

单个实例一次只运行一个任务。每项任务启动一个原版进程；会话历史通过 DSH 持久化恢复。适配层不复制 Agent loop、模型调用或工具实现。进程 stderr 仅用于失败诊断，诊断会限制为 8 KiB 并遮盖环境变量中的 API key、token、secret 和 password 值；stdout 事件会按相同规则遮盖。

## 来源与许可

依赖固定为官方 npm 包 `@deepseek-ai/dsh@0.2.0-rc.2`，并遵循上游 MIT 许可，副本见 [`LICENSE`](./LICENSE)。本地 Reference checkout 的来源提交记录在 [`agent-package.json`](./agent-package.json)；该字段只记录 Reference revision，不声明它与 npm 发布物使用相同 Git commit。上游 CLI、headless JSON 投影、session 持久化和工具安全配置均由依赖拥有。

## 已知限制

- 上游 JSON 投影只发布已提交消息，不提供实时 token 流；最终答案用 `assistant-replace` 修正任何截断的中间 text。
- stdout 若收到未知但格式正确的事件，会以 `harness-event` 透传。超长 final 由上游按原样提供。
- 宿主 `sessionId` 必须在同一 `stateDir` 下保持稳定；更换 stateDir 会失去本包的映射。Harness 原生 session 还会校验 workspace 路径和 profile 条件。
- 每个任务都会启动独立 CLI 进程，启动时间高于长驻 SDK server；这是为了让原版 headless 的 SIGINT 清理和持久 session 恢复保持原有语义。

本包单元测试：`npm test`。在构建好官方 DSH runtime 后，可用 `npm run smoke:mock` 通过本地 Messages-compatible SSE 服务检查原版工具往返、文件读取、多轮历史、取消恢复和 provider 错误；测试不访问真实 API，也不需要付费 key。
