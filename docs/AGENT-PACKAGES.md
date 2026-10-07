# 声明式 Agent 包

t-alent 0.2.0 将 Agent 包收敛为数据程序。每个包只有 `agent-package.json` 和 `prompts/`；框架读取 JSON 流程、编译提示词，再用指定的原生 Harness 适配器执行。包的流程与提示词由 t-alent 管理，原生 Harness 的工具循环、上下文、审批和模型协议编码由适配器保留。

```text
packs/codex/
├── agent-package.json
└── prompts/
    ├── system.md
    ├── protocol-openai-responses.md
    └── task.md

packages/runtime/adapters/codex/   固定依赖、运行时实现、测试与许可证
agent-sources/codex/0.2.0.json      该包版本对应的来源 Agent 版本与来源证据
```

包不携带可执行 JavaScript，不写入 `node_modules`，也不包含编译缓存。旧式 `entry` 插件仍可显式加载以兼容已有插件，但新格式不能混用 `entry`。

## 编写一个包

复制一个现有包，修改 `id`、名称、版本、流程和提示词；无需复制 SDK 或适配器源码。下面的包通过框架里的 Codex 适配器运行：

```json
{
  "schemaVersion": 1,
  "id": "my-coder",
  "name": "My coder",
  "version": "1.0.0",
  "source": { "agent": "codex", "version": "0.159.3" },
  "modelProtocols": ["openai-responses"],
  "prompts": {
    "system": "system.md",
    "protocol": "protocol.md",
    "task": "task.md"
  },
  "logic": {
    "adapter": "codex",
    "defaults": {},
    "steps": [
      { "type": "prompt", "ref": "system" },
      { "type": "prompt", "ref": "protocol", "when": { "protocol": "openai-responses" } },
      { "type": "prompt", "ref": "task" },
      { "type": "execute" }
    ]
  }
}
```

`system.md` 写该 Agent 的处理方式，例如先阅读项目约定、修改代码并运行相关检查。`protocol.md` 写已选协议或模型的使用要求。`task.md` 可以这样写：

```text
在 {{workspace}} 完成任务，遵守项目约定。
所选模型：{{model.provider}}/{{model.model}}
用户请求：
{{input}}
```

执行时，匹配的提示词按 JSON 中的顺序拼接成原生 Harness 的任务输入。这里的 `system.md` 是包的指令片段；它不会覆盖上游私有或默认 system prompt。包内提示词是 t-alent 的任务编排指令，不声称等同于完整上游提示词。

`prompt` 步骤引用一个逻辑名称。可选 `when` 对当前模型的 `protocol`、`provider`、`model` 作精确匹配；多个条件须全部满足。条件只适配用户已经选定的外部模型，不负责选模型。每个流程最后只能有一次 `execute`，由所选适配器运行任务并返回通用事件。`task` 必须无条件引用一次，且包含 `{{input}}`，避免丢失用户请求。

`logic.defaults` 设置 Harness 行为参数，宿主 `--config` 中对应包 ID 的值可以覆盖它。模型、提供商、端点、密钥与密钥引用仍由独立 `--models` 文件和环境变量提供，不能写入包默认配置。支持的协议必须是所选适配器实际支持的协议子集；模型服务还需要具备原生 Harness 所需的工具能力。

新增原生 Harness 时，先在框架中实现适配器并登记固定来源版本与协议能力，再制作对应 JSON 包。修改任意包的流程和提示词不需要修改宿主代码。

## 模板和编译

模板只支持以下固定变量，不执行表达式或代码：

| 变量 | 值 |
| --- | --- |
| `input` | 当前用户任务，作为原文插入，不再次解释模板 |
| `workspace` | 宿主选定的工作区 |
| `model.id`、`model.provider`、`model.model`、`model.protocol` | 当前外部模型 profile 的公开字段 |
| `package.id`、`package.version` | 当前包的标识与版本 |
| `source.agent`、`source.version` | 来源 Agent 标识与固定版本 |

加载时校验 JSON、流程、目录结构、模板变量、UTF-8、文件数量和大小，再将模板编译为字面量/变量 token，将流程与协议表编译为 JSON IR。任务执行期间只渲染已经编译的 IR，不重新读取提示词。

每次显式加载都会重新读取源文件并计算内容指纹。指纹包含编译器版本、规范 JSON、提示词路径及字节哈希、包目录；来源版本也在 JSON 中参与指纹。相同内容命中进程内缓存或 `<state-dir>/cache/agents/` 磁盘缓存，跳过重复模板编译。内容变化、编译器升级或损坏缓存会重新编译；同大小、相同修改时间的提示词修改也不会误命中。磁盘 IR 必须与源清单和源模板重拼内容一致，不能用缓存绕过源校验。

缓存不保存模型实例、密钥、用户任务或会话。进程内缓存最多 128 个程序。磁盘缓存可在宿主停止后删除，下次加载会重建。加载缓存只优化包处理与提示词准备，不缩短模型推理或工具自身耗时；小包的磁盘缓存校验可能比直接编译更慢。可用 `npm run bench:agents` 测量本机各包的编译、缓存加载和任务渲染时间。

## 版本与会话

`version` 是 t-alent Agent 包的 SemVer 版本，`source.version` 是对应官方 Agent/SDK/CLI 的固定版本，两者独立。例如 Codex 包 `0.2.0` 对应来源 `0.159.3`。来源版本必须与框架安装的适配器一致，不能写 `latest` 或版本范围。

仓库在 `agent-sources/<包 ID>/<包版本>.json` 中记录每个分发包对应的来源版本、仓库、可核实的提交、依赖锁定信息和许可证位置。升级流程如下：

1. 仅修改提示词或流程时提高包版本，保留来源版本。
2. 升级上游时更新适配器依赖、registry 固定版本和包的 `source.version`，重新运行原生 mock 验证。
3. 为新的包版本新增来源记录，保留旧记录，然后重新打包。

未提供来源 commit 的上游明确记录未知，不根据 npm 版本猜测提交。

CLI 新会话记录包版本、来源版本和编译指纹。恢复时发现版本或指纹不一致会拒绝续用并提示创建新会话。原生会话键也包含程序指纹，避免修改后的指令混入旧上游历史。旧 CLI 元数据仍可读取；它未记录版本时无法提供同样的版本锁定保证。

## 分发与验证

```sh
npm run pack:agents
npm run verify:agents
npm test
npm run build
```

`dist/packages/` 为所有已注册包生成带包版本的 `.tar.gz` 和 `SHA256SUMS`。归档中的 `package/` 只含 JSON 与提示词。解压后把该目录交给已安装依赖的 t-alent 框架：

```sh
mkdir -p /tmp/my-codex
# 替换为实际分发文件路径
tar -xzf dist/packages/t-alent-agent-codex-0.2.0.tar.gz -C /tmp/my-codex
node apps/cli/index.mjs --package /tmp/my-codex/package \
  --models config/models.local.json --workspace . --harness codex
```

普通 `verify:agents` 在独立临时目录验证所有已注册归档的校验值、结构、来源记录、编译和适配器生命周期，不联网安装依赖。`npm run verify:agents -- --real-smoke` 另外用固定原生 SDK/CLI 连接本机模拟 API 验证工具往返等行为；需要允许监听本地回环端口，Goose 需要准备固定版本二进制。不会调用付费模型 API。
