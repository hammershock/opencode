# OpenCode Remote Enhanced

OpenCode 的远程开发增强版，基于 [anomalyco/opencode](https://github.com/anomalyco/opencode) `v1.18.27`，配合 REXD 将文件和命令透明路由到远程主机。

> 当前预编译包支持 macOS Apple Silicon（arm64）。项目保留官方 OpenCode 的 MIT 许可证；REXD 插件源码维护在 [hammershock/opencode-rexd-target](https://github.com/hammershock/opencode-rexd-target)。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/hammershock/opencode/remote-session-context/scripts/install-rexd.sh | bash
```

安装后使用独立命令启动，不覆盖官方 `opencode`：

```bash
opencode-rexd
```

需要先配置 `~/.config/rexd/targets.json`，并在目标主机安装和运行 [REXD](https://github.com/samiralibabic/rexd)。

## 新特性

- 会话绑定远程 target 和远程工作目录。
- 底栏显示 `target:/remote/cwd`。
- `/sessions` 显示并可搜索 `target:/remote/cwd`。
- `/target list|status|use|clear` 在 TUI 本地执行，不进入模型上下文、不消耗 token。
- `/target add <ssh-alias>` 使用 `cwd=~`、`workspaceRoots=/` 快速配置；不带 alias 时打开完整向导。
- 首次 `/target use <alias>` 会通过 SSH 自动安装、校验并握手 REXD；成功后才切换会话，失败时保留原 target。
- `/expand` 通过键盘展开或收起所有截断的命令输出，无需终端支持鼠标点击。
- Codex 风格 `/cd`，支持相对路径、`.`、`..`、`~`、引号路径和转义空格。
- Codex 风格 `/permissions`，可选择询问授权或自动批准；auto 模式在底栏显示 `auto`。
- `!command` 在激活 target 时通过 REXD 远程执行，未激活时保持本地执行。
- `/move` 在远程会话中切换远程 cwd，并校验 `workspaceRoots`。

## 更新与卸载

重新运行安装命令即可更新。安装器会备份已有 REXD 插件，并保留官方 `opencode`。

卸载增强版：

```bash
trash ~/.local/bin/opencode-rexd ~/.local/lib/opencode-rexd
```

## 源码

- 上游 OpenCode：[anomalyco/opencode](https://github.com/anomalyco/opencode)
- 增强版 OpenCode：[hammershock/opencode](https://github.com/hammershock/opencode)
- 增强版插件：[hammershock/opencode-rexd-target](https://github.com/hammershock/opencode-rexd-target)

详细的上游文档与多语言 README 请参阅官方仓库。
