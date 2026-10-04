# DeepSeek Agent 包

此包通过固定版本的官方 `@deepseek-ai/dsh` 命令运行原版 `headless` profile，保留原版 Harness 的 Agent 循环、工具和会话恢复。包只提供 Harness；模型由宿主可信 registry 解析为 profile 后传入每个任务。

## 使用

```js
import { createAgentPackage } from '@t-alent/agent-deepseek'

const agent = await createAgentPackage({
  workspace: '/srv/workspaces/project',
  stateDir: '/srv/state/project',
  env: process.env,
  config: { reasoningEffort: 'high' },
})
const model = {
  id: 'deepseek-production',
  name: 'DeepSeek production',
  provider: 'deepseek',
  model: 'your-model-id',
  protocol: 'deepseek',
  apiKeyEnv: 'DEEPSEEK_PRODUCTION_KEY',
  // 可选：兼容 Anthropic Messages 的 API 根地址
  baseUrl: 'https://api.example.com/anthropic',
}

try {
  for await (const event of agent.executeTask(
    { taskId: 'task-42', input: '检查这个项目', sessionId: 'conversation-9', model },
  )) console.log(event)
} finally {
  await agent.dispose()
}
```

`model` 必须是外部 registry 给出的完整 profile。此 Harness 接受 `protocol: 'deepseek'`，并通过 DeepSeek 官方 Messages 适配器路由；`model` 是传给上游的模型 ID，`provider` 是外部 profile 元数据，内部 Harness 路由固定为 `deepseek-official`。Profile 的 `apiKeyEnv` 指向宿主进程环境变量；包将该值映射到原版运行时要求的 `DEEPSEEK_API_KEY`，不会把密钥写进 patch、事件或清单。无 `baseUrl` 时 endpoint 固定为官方 Messages 根地址。URL 必须为不含用户名、密码、查询或片段的 HTTP(S) 地址。

旧的 `config.model`、`config.provider`、`config.baseUrl`、`config.baseURL` 不再接受；`DEEPSEEK_MODEL` 与 `DEEPSEEK_BASE_URL` 不会决定任务模型或 endpoint。迁移时删除这些旧设置，把模型及可选 endpoint 放入宿主 model registry，并在每次 `executeTask` 调用传完整 `model` profile。过去调用 `listModels()` 的宿主应改由自己的 registry 提供选择器数据；本包不导出或查询模型目录。`config.reasoningEffort`、`config.maxTokens`、`config.patches`、`config.cancelGraceMs` 等 Harness 行为配置仍可使用。推理强度和输出上限作为前置行为 patch 写入，调用方 patch 仍可覆盖这些行为值；最后应用的 profile route patch 固定该任务模型和 endpoint。

Harness home 固定在 `stateDir/dsh`。会话映射包含宿主会话及 profile 标识、供应商、模型、协议、endpoint 和密钥环境变量引用；切换 profile 或模型会开启另一条上游会话，避免在不同 endpoint 间误恢复历史。使用同一 profile 与宿主会话 id 时，原版 headless 会恢复持久历史。取消先向原版 CLI 发送 SIGINT 并等待退出与 session 落盘，之后才使用 SIGKILL。

任务事件来自原版 `--json` NDJSON 投影。`text` 映射为 `assistant-delta`，`final` 映射为无损的 `assistant-replace`；`thinking` 映射为 `reasoning`，工具事件映射为 `tool-call`/`tool-result`，status 以 `harness-event` 提供。只有成功退出、存在 `final` 且 turn 完成为 completed 时才发送 `assistant-complete`。错误只发送一次 `error`，取消只发送 `cancelled`。环境凭据会在子进程输出和返回事件中遮盖。

## 验证

运行 `npm test --workspace packs/deepseek`。`npm run smoke:mock --workspace packs/deepseek` 启动原版 DSH CLI，并连接本机 Messages mock，验证工具往返、多轮历史、取消恢复、profile 模型与密钥路由及 provider 错误；不调用真实模型 API，也不产生付费请求。

## 来源与许可

依赖固定为官方 npm 包 `@deepseek-ai/dsh@0.2.0-rc.2`，并遵循上游 MIT 许可。上游 CLI、headless JSON 投影、session 持久化和工具安全配置均由依赖拥有；本包仅提供宿主适配。
