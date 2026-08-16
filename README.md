# pi-v4-anchor

面向 Pi 的可逆 DeepSeek V4 Pro 首请求 trajectory anchor。它基于
`pi-deepseek-anchor` 的 Minimal bootstrap 思路重写，兼容 Pi 当前的三种
DeepSeek V4 Pro 兼容 API：OpenAI Responses、OpenAI Chat Completions 和
Anthropic Messages (`/v1/messages`)。

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

扩展默认关闭。仅在全新 session 中执行 `/v4-anchor on` 后，它会：

1. 保存当前 active tools 作为精确 baseline。
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
5. 首个普通 assistant 响应完成后恢复 baseline tools。
6. 如果首答调用工具，则在首个 tool result 后恢复 baseline，并在同一 agent
   run 的下一次 provider 请求中恢复原 system prompt。
7. `/v4-anchor off` 使所有 anchor hooks 旁路；armed 状态恢复启用前的工具集合。
   promoted 状态已经恢复 baseline，不会因关闭或模型切换覆盖用户之后的
   active-tool 调整。

扩展不会替换 Pi 的 bash executor，因此保留 Pi 配置的 shell、`shellPath` 和
`shellCommandPrefix`。Windows editor 接受以下绝对路径：

- `C:/work/file.ts`
- `C:\\work\\file.ts`
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
后，完整工具集合恢复，后续请求可以正常使用 Magic Context 工具。

如果另一个扩展替换了 Pi 内建 `bash`，anchor 会拒绝启用。对于
`str_replace_editor`，Pi 采用 first-registration-wins，运行时只暴露获胜定义；如果
获胜定义属于其他扩展，anchor 会拒绝启用。不要同时加载另一个声明同名 editor 的
扩展，因为隐藏的重复注册无法通过 Pi 0.84.2 公开 API 检出，加载顺序会决定谁生效。
Magic Context 不注册这个名称，因此不涉及该冲突。

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

安装后启动一个全新的 Pi session，选择任意 provider 下的目标模型，并使用最大
reasoning（如果该 provider 支持）：

```text
<provider>/deepseek-v4-pro
/thinking max
/v4-anchor on
```

`/on` 必须在第一条普通用户消息之前执行。可用命令：

```text
/v4-anchor on
/v4-anchor off
/v4-anchor status
```

`status` 可能显示以下阶段：

- `off`：所有 anchor 行为旁路。
- `bootstrap`：已启用，等待首个 provider 请求。
- `in-flight`：首个 anchor 请求正在执行。
- `promoted`：首请求已完成，baseline tools 已恢复。

启用期间切换模型会自动关闭 anchor。reload 会在仍然 fresh 的 branch 上恢复
armed 状态；armed branch 遇到 fork、compaction 或已有对话时会恢复 baseline 并关闭。
`promoted` 已不再改写请求，因此 reload/fork 只恢复 baseline tools 并保留 promoted 标记。

## 安全边界

这是 trajectory calibration 实验，不是安全沙箱，也没有证明一定提升任务质量。
首请求会有意以 Minimal persona 替换 Pi 和项目 system instructions；此时虽然
wire payload 只有两个工具，但内建 bash 仍拥有当前用户的宿主权限。只应在理解
这一行为后使用。

如果 payload 缺少 anchor 工具对、模型/API 改变、bash 已被其他扩展替换，或
当前可见 editor 不属于本扩展，扩展会恢复 baseline、持久化 `off` 并给出 warning。
同名 editor 的隐藏重复注册属于上述 Pi first-registration-wins 限制。

## 开发验证

```powershell
npm install
npm test
npm run check
npm pack --dry-run
```

显式付费的真实 provider smoke test 会发出一次 `max` reasoning 请求，并把输出上限
临时设为 2048。默认会从本机 model catalog 中选择一个 model id 以
`deepseek-v4-pro` 结尾的模型；也可以显式指定：

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
以及不调用模型的 Pi SDK 加载、命令和 reload 集成测试。

## 来源

实现借鉴并改写了 `pi-deepseek-anchor`、`dsh-anchored-standard` 和
DeepSeek Harness 的 Minimal anchor 概念及部分 prompt/tool 文本。完整来源与
revision 见 [NOTICE](NOTICE)，许可证见 [LICENSE](LICENSE)。
