# pi-lsp

pi 的 LSP 扩展，行为与 Claude Code 的 LSP 工具对齐。

它给 pi 提供两样东西：

- **`lsp` 工具**：与 Claude Code 的 `LSP` 工具相同的 9 个操作、相同的参数、相同的输出文本，让模型做跳转定义、找引用、悬停、文档与工作区符号、找实现、调用关系。
- **编辑后的诊断**：模型用 edit / write 改完文件后，语言服务器报出的错误与告警在下一次请求模型之前送到模型面前，格式与 Claude Code 的 `<new-diagnostics>` 相同。

## 支持的语言

| 语言 | 语言服务器 | 扩展名 |
|---|---|---|
| C / C++ | `clangd --background-index` | `.c .h .cpp .cc .cxx .hpp .hxx .hh` |
| Go | `gopls` | `.go` |
| Rust | `rust-analyzer` | `.rs` |
| TypeScript / JavaScript / React | TS 7 的 `tsc --lsp --stdio`；项目自带 TS 7 以下时用 `typescript-language-server --stdio` | `.ts .mts .cts .tsx .js .mjs .cjs .jsx` |
| Python | `pyright-langserver --stdio` | `.py .pyi` |
| CSS / SCSS / Less | `vscode-css-language-server --stdio` | `.css .scss .less` |
| HTML | `vscode-html-language-server --stdio` | `.html .htm` |

## 安装

```bash
pi install git:https://github.com/yinziyang/pi-lsp.git
```

装好后新开一个 pi 会话。
机器上至少有一个语言服务器可用时，工具列表里会出现 `lsp`。

语言服务器可以自己装，也可以让扩展装：

```
/lsp install typescript   # TS 7 与 typescript-language-server
/lsp install python       # pyright
/lsp install css          # HTML 与 CSS 语言服务器
/lsp install go           # gopls，需要本机有 go
/lsp install rust         # rust-analyzer，需要本机有 rustup
```

- npm 类的服务器装到 `~/.pi/agent/lsp/node/`，gopls 装到 `~/.pi/agent/lsp/bin/`，不改动 npm 的全局目录。
- clangd 不由扩展安装：macOS 用 Xcode 命令行工具自带的（`xcode-select --install`），Linux 用系统包管理器。
- 模型用到一个没装的服务器时，交互模式下会先弹确认再安装；`-p` 等非交互模式默认不安装，只在工具结果里说明怎么装，设置 `lsp.autoInstall: true` 后自动安装。
- 刚装好的服务器在下一次会话开始时注册工具（一个服务器都没有时不注册 `lsp` 工具）。

## 命令

- `/lsp`：列出各服务器的状态、进程号、项目根、最近错误与扩展名冲突。
- `/lsp install <语言>`：安装语言服务器。
- `/lsp restart [服务器]`：重启服务器。

## 配置

写在 pi 的 `~/.pi/agent/settings.json`，或受信项目的 `.pi/settings.json`（后者覆盖前者）的 `lsp` 键下：

```json
{
  "lsp": {
    "idleTimeoutMinutes": 10,
    "autoInstall": false,
    "diagnostics": true,
    "servers": {
      "gopls": { "args": ["-remote=auto"] },
      "html": { "enabled": false },
      "lua": { "command": "lua-language-server", "extensionToLanguage": { ".lua": "lua" }, "rootMarkers": [".luarc.json"] }
    }
  }
}
```

- `servers` 的字段沿用 Claude Code 插件 `.lsp.json` 的格式：`command`、`args`、`extensionToLanguage`、`env`、`initializationOptions`、`settings`、`workspaceFolder`、`startupTimeout`、`shutdownTimeout`、`restartOnCrash`、`maxRestarts`、`diagnostics`，可以直接照抄 Claude Code 的插件配置。
- 另外的字段：
  - `requestTimeout`：单个请求的超时，毫秒，默认 60000。
  - `rootMarkers`：找项目根用的标记文件。
  - `pullDiagnostics`：是否向服务器声明支持拉取诊断，默认 true；内置的 pyright 默认关闭。
  - `enabled`：设为 false 关掉一个内置服务器。
- 与内置同名的条目按字段覆盖内置配置；写了 `command` 的不再按项目自动选择启动命令。

## 与 Claude Code 的差异

模型能看到的东西（工具说明、参数、9 个操作的输出文本、诊断消息的格式与送达时机）默认与 Claude Code 逐字一致。
以下是有意的差异，代码注释里标了同样的编号。

不改变模型看到的格式：

| # | Claude Code | pi-lsp |
|---|---|---|
| D1 | 服务器活到会话结束 | 空闲 10 分钟回收，下次用到再启动 |
| D2 | 启动、关闭、请求的等待都没有上限 | 启动 30 秒、请求 60 秒；关闭依次是 shutdown（3 秒）、exit（2 秒）、SIGTERM（2 秒）、SIGKILL |
| D3 | 只接收推送诊断 | 同时支持拉取（TS 7 只支持拉取），服务器要求刷新时重新拉取 |
| D4 | 不处理 `client/registerCapability` 等反向请求 | 接受并记录动态注册，应答进度请求 |
| D5 | 不等服务器推送，诊断常常晚一轮 | edit / write 后等诊断：安静 150ms 就收，最多 3 秒；更晚到的下一轮送 |
| D6 | 用 Bash 改的文件服务器不知道 | bash 之后比对已打开文件的磁盘内容，变了就同步 |
| D7 | 项目根只用启动目录 | 按 `go.mod`、`Cargo.toml`、`compile_commands.json` 等标记为每个文件找项目根 |
| D8 | `.h` 一律当 C | 按编译数据库或项目里有没有 C++ 源文件判断 |
| D9 | 不识别 Python 虚拟环境 | 探测 `VIRTUAL_ENV`、`.venv`、`venv`、`CONDA_PREFIX` 并下发给 pyright |
| D10 | 只能经 Claude Code 插件配置，不安装服务器 | 内置服务器表，可在 pi 设置里覆盖；缺的服务器可以安装 |
| D11 | 插件装了就算有服务器 | 命令能找到才算有服务器；一个都没有时不注册工具 |
| D12 | 子代理的诊断转给主会话 | 后台子代理的诊断送给它自己（pi 的后台子代理是独立进程） |

改变模型看到的内容：

| # | Claude Code | pi-lsp |
|---|---|---|
| V1 | 诊断只写文件名 | 写相对路径 |
| V2 | Hint 级别也送 | 不送 Hint |
| V3 | 问题修好了不告诉模型 | 之前报过诊断、编辑后全部消失时报一行 `<路径>: all previously reported issues are resolved` |
| V4 | 没有使用引导 | 工具说明末尾加一句：查定义、引用、实现、调用者时优先用 lsp 而不是 grep |

## 生命周期

每个语言服务器进程都有确定的结束路径，不留死进程：

- 会话结束（退出、重载、新建、恢复、分叉）时关闭本会话的全部服务器。
- 空闲超过 `idleTimeoutMinutes` 关闭。
- 服务器放在单独的进程组里，关闭时连同它起的子进程（例如 gopls 的 telemetry 进程）一起收掉。
- pi 被强杀时，服务器的 stdin 管道随之断开，服务器自行退出。
- 每个服务器进程在 `~/.pi/agent/lsp/pids/` 留一条记录；下次会话开始时，清理上一个 pi 已退出却仍在运行的服务器（按命令名核对，进程号被复用时不杀）。

## 已知限制

- Apple clangd 17 不支持 `callHierarchy/outgoingCalls`，这个操作会原样返回服务器的报错；装较新的 LLVM clangd 可以解决。
- rust-analyzer 在会话里第一次编辑后，自身分析给出的诊断可能晚一轮才到；`cargo check` 的诊断照常送达。
- 编辑后某一路诊断 8 秒内没有重新上报时按清空处理；`cargo check` 很慢且仍有错误时，会先报「已消失」、随后再报那条错误。
- clangd 在没有 `compile_commands.json` 的真实项目里会按默认编译参数解析，可能报找不到头文件；这是 clangd 自身的限制。

## 开发与测试

```bash
npm install
npm test                     # 单元测试：假语言服务器驱动协议、生命周期、诊断、工具与安装逻辑
npm run typecheck            # TypeScript 严格模式
npm run test:real            # 真实语言服务器：各语言的诊断、导航、项目根与服务器选择
npm run test:install         # 真实安装：在空目录里安装各服务器并启动（联网）
node eval/pi/lifecycle.mjs   # 真实 pi 里的生命周期：退出、kill -9、新建与切换会话、多会话、子代理进程（调用模型）
node eval/pi/e2e.mjs         # 真实 pi 里的端到端与共存（调用模型）
node eval/pi/ui.mjs          # 真实 pi 里的安装确认、非交互安装、/lsp 状态与重启（联网安装，调用模型）
node eval/pi/compare.mjs     # 装与不装 pi-lsp 的对照：最终代码能否通过编译与类型检查（调用模型）
node eval/parity/parity.ts   # 与 Claude Code 的 LSP 工具逐字节对比（需要 Claude Code 与官方 LSP 插件，调用模型）
```

## 许可证

MIT
