# pi-v4-anchor

面向 Pi 的 DeepSeek V4 Pro trajectory anchor。它基于 `pi-deepseek-anchor` 的
Minimal bootstrap 思路重写，兼容 Pi 当前的三种 DeepSeek V4 Pro 兼容 API：
OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages (`/v1/messages`)。

## 匹配范围

扩展不绑定任何 provider。它只要求当前模型的 `id` 以精确后缀
`deepseek-v4-pro` 结束，并且 API 是以下之一：

- `openai-responses`
- `openai-completions`
- `anthropic-messages`

因此 `provider-a/deepseek-v4-pro`、`gateway/deepseek-v4-pro` 和其他 provider
下的同一模型后缀都可以匹配；`deepseek-v4-pro-preview` 和
`deepseek-v4-pro:free` 不匹配。

## 行为

扩展默认关闭。`/v4-anchor on` 会在当前 `PI_CODING_AGENT_DIR` 写入一个只含
`{ "version": 1, "enabled": true }` 的用户级意图文件。任何发现并加载了本扩展、且
共享该 agent directory 的 Pi 进程都会在自身的 session 启动、模型选择和首个 provider
请求边界检查该意图与模型；这包括 pi-subagents 启动的子 Pi。

实际 bootstrap 仍只会发生在全新、未 compact、未 fork 且没有已有对话的目标模型 branch：

1. 在目标模型上保存当前 active tools 作为精确 baseline。
2. 保留其他扩展工具在 Pi 的 active 集合中，并临时确保本扩展的
   `str_replace_editor` 可用。
3. 首个 provider wire payload 只暴露内建 `bash` 与
   `str_replace_editor`，使用 Minimal persona。
4. 按 API 原生格式重写首请求：
   - Responses：`input`、`instructions`、`tools`、`tool_choice`、
     `max_output_tokens` 和 Responses 会话字段。
   - Chat Completions：`messages`、OpenAI function tools、
     `tool_choice`、`max_tokens`/`max_completion_tokens`。
   - Anthropic Messages：顶层 `system`、`messages`、`input_schema` 工具、
     `tool_choice` 和 `max_tokens`。
5. 首个普通 assistant 响应或首个 tool result 后恢复完整 baseline tools。
6. `promoted` 默认是 persistent：后续每个 provider wire payload 继续保留 Minimal
   system persona；原 Pi、项目和 Magic Context system prompt 会作为标记化的
   `<v4-anchor-context>` user-context 项回注，而不会恢复到 system role 或写回 session。
7. `/v4-anchor off` 关闭共享意图。当前 armed branch 恢复启用前的工具集合；已
   promoted branch 已恢复 baseline，不会覆盖用户之后的 active-tool 调整。

非目标模型处于 `standby`，不会发送 anchor payload。用户随后切换到一个全新的目标模型
branch 时，只要共享意图仍开启，它会自动 armed；不会因非目标模型而清除全局意图。

扩展不会替换 Pi 的 bash executor，因此保留 Pi 配置的 shell、`shellPath` 和
`shellCommandPrefix`。Windows editor 接受以下绝对路径：

- `C:/work/file.ts`
- `C:\work\file.ts`
- Git Bash `/c/work/file.ts`
- WSL `/mnt/c/work/file.ts`

无法明确映射盘符的 Windows POSIX 路径（例如 `/work/file.ts`）会被拒绝。

## 与其他扩展共用

工具注册和工具 active 状态与其他扩展共存。比如 Magic Context 的
`ctx_search`、`ctx_memory`、`ctx_note`、`ctx_expand`、`ctx_reduce` 和
`todowrite` 不会被 anchor 注销、覆盖或从 baseline 丢失；首轮完成后它们会
出现在恢复后的 provider 请求中。

首个 bootstrap 请求只发送 `bash` 和 `str_replace_editor` 是 anchor 的刻意
轨迹约束。因此其他工具虽然仍注册并保持在 Pi runtime 的 active 集合中，但
模型在这一个 wire request 中不能调用它们。首轮返回文本或完成首个 tool result
后，完整工具集合恢复，后续请求可以正常使用 Magic Context 工具。Persistent
模式同时会把 Pi/Magic Context system 内容作为 wire-only user context 回注，以保持
Minimal persona 的 system role。

如果另一个扩展替换了 Pi 内建 `bash`，anchor 会拒绝启用。对于
`str_replace_editor`，Pi 采用 first-registration-wins，运行时只暴露获胜定义；如果
获胜定义属于其他扩展，anchor 会拒绝启用。不要同时加载另一个声明同名 editor 的
扩展，因为隐藏的重复注册无法通过 Pi 0.84.2 公开 API 检出，加载顺序会决定谁生效。
Magic Context 不注册这个名称，因此不涉及该冲突。

## pi-subagents

共享意图默认由子进程继承的 `PI_CODING_AGENT_DIR` 传递。因此父 Pi 执行
`/v4-anchor on` 后，任何加载本扩展且选择目标模型的 fresh 子 Pi 都会自行 armed，
无需在每个 child session 再执行命令。

`pi-subagents` 的 agent `tools` 是严格白名单。需要完整 bootstrap 的可写 child 必须允许
`bash` 和 `str_replace_editor`。本机的用户 scope `worker` 与 `delegate` 已配置这两者；
`reviewer`、`scout` 等只读 agent 不会为 anchor 增加 shell 或 editor 权限，因而会 fail
closed 而不是静默弱化两工具约束。自定义 agent 若显式配置 `extensions` 并因此禁用 ambient
package discovery，还必须通过 `extensions` 或 `subagentOnlyExtensions` 加载本包的 provider。

## 安装

从 GitHub 安装：

```powershell
pi install git:github.com/mapleluvr/pi-v4-anchor
```

也可以从克隆后的本地目录安装：

```powershell
pi install "."
```

或只在一次运行中加载：

```powershell
pi -e "."
```

安装后可在任意 Pi session 中打开共享意图，再选择任意 provider 下的目标模型，并使用
最大 reasoning（如果该 provider 支持）：

```text
/v4-anchor on
<provider>/deepseek-v4-pro
/thinking max
```

`/on` 本身不要求当前模型已经匹配；非目标模型会显示 `standby`。实际 bootstrap 必须发生在
该 Pi 的第一条普通用户消息之前的全新目标模型 session。可用命令：

```text
/v4-anchor on
/v4-anchor off
/v4-anchor status
```

`status` 可能显示以下阶段：

- `off`：共享意图关闭，所有 anchor 行为旁路。
- `standby`：共享意图开启，但当前模型不匹配或当前 branch 不可 fresh bootstrap。
- `bootstrap`：目标模型已 armed，等待首个 provider 请求。
- `in-flight`：首个 anchor 请求正在执行。
- `promoted:persistent`：首请求已完成，baseline tools 已恢复，后续请求持续保持
  Minimal system persona，并以 wire-only user context 回注原 system 内容。

切换到非目标模型只会进入 `standby`，不会关闭共享意图。reload 会在仍然 fresh 的目标
branch 上恢复 armed 状态；armed branch 遇到 fork、compaction 或已有对话时会恢复 baseline
并关闭该 branch 的 armed 状态。`promoted` branch 在 reload/fork 后仍持续使用 persistent
payload 改写，但不会重新执行首次两工具 bootstrap。

## 安全边界

这是 trajectory calibration 实验，不是安全沙箱，也没有证明一定提升任务质量。Persistent
是默认行为：模型的 system role 会持续使用 Minimal persona，原 Pi、项目和其他扩展的
system instructions 会在 promotion 后作为 `<v4-anchor-context>` user message 发送。这会
有意改变原 system instructions 的角色优先级，也会把本来由 system role 携带的上下文发送给
模型；只应在理解这一语义后使用。

首请求会有意以 Minimal persona 替换 Pi 和项目 system instructions；此时虽然 wire payload
只有两个工具，但内建 bash 仍拥有当前用户的宿主权限。只应在理解这一行为后使用。

如果 payload 缺少 anchor 工具对、模型/API 改变、bash 已被其他扩展替换，或当前可见 editor
不属于本扩展，扩展会恢复 baseline、关闭当前 branch 的 anchor 状态并给出 warning。共享
意图文件不保存 prompt、session、模型配置或认证信息。同名 editor 的隐藏重复注册属于 Pi
first-registration-wins 限制。

## 开发验证

```powershell
npm install
npm test
npm run check
npm pack --dry-run
```

显式付费的真实 provider smoke test 会发出一次 `max` reasoning 请求，并把输出上限
临时设为 2048。默认会优先选择具有可用认证的 model id 以 `deepseek-v4-pro` 结尾的模型；
也可以显式指定：

```powershell
$env:PI_V4_ANCHOR_PROVIDER = "your-provider"
$env:PI_V4_ANCHOR_MODEL = "deepseek-v4-pro"
npm run test:live
```

命令以及 tool-continuation 版本：

```powershell
npm run test:live
npm run test:live:tool
```

测试包含纯 payload/state 测试、真实临时文件测试、fake runtime 生命周期测试，
以及不调用模型的 Pi SDK 加载、命令、reload 和跨 session 共享 intent 集成测试。

## 来源

实现借鉴并改写了 `pi-deepseek-anchor`、`dsh-anchored-standard` 和
DeepSeek Harness 的 Minimal anchor 概念及部分 prompt/tool 文本。完整来源与
revision 见 [NOTICE](NOTICE)，许可证见 [LICENSE](LICENSE)。
