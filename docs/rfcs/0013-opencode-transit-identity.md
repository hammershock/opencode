---
id: 0013
title: OpenCode Transit Product Identity and Distribution
status: accepted
authors:
  - hammershock
created: 2026-09-11
updated: 2026-09-11
implemented-by: []
depends-on:
  - 0002
  - 0010
supersedes: []
superseded-by: []
---

# RFC-0013：OpenCode Transit 产品身份与发行

## 摘要

本 fork 的公开产品名为 **OpenCode Transit**，GitHub 仓库名为 `opencode-transit`，用户入口为 `opencode-transit`。它是增强 OpenCode 跨设备工作空间、远程 Location 与连续 Session 能力的独立发行版，不是 OpenCode 官方团队开发、认可或维护的产品。

本 RFC 只改变 fork 的公开身份、发行和兼容契约。源码目录、workspace package、内部 import、Protocol `rexd/1` 以及现有 OpenCode 配置和数据目录继续保持兼容命名，避免无价值的上游同步冲突。

## 产品身份

- 展示名称统一使用 `OpenCode Transit`，不缩写为一个容易被误解成官方版本的名称。
- 仓库迁移到 `hammershock/opencode-transit`，`upstream` 继续指向只读的 `anomalyco/opencode`。
- README、安装页、Release 和 `--version` 附近必须明确说明：本项目基于 OpenCode，但不是 OpenCode 官方项目，也不与 OpenCode 团队存在隶属关系。
- 保留上游 MIT 许可、版权和贡献者归属，并在 README 中提供显著的 upstream 链接。
- Logo 必须原创并与上游标志清晰区分；不得仅修改上游 Logo 的颜色、文字或局部形状。

## 命令与安装边界

正式入口为：

```text
opencode-transit
```

安装器不得创建或覆盖 `opencode`。已有 `opencode-rexd` 用户获得一个次版本周期的兼容启动器：它先在 stderr 输出弃用提示，再把参数和退出状态原样转发给 `opencode-transit`。兼容期结束前，删除入口必须在 Release notes 中提前说明。

安装、升级和旧入口迁移都采用候选文件验证后原子替换。失败时保留当前可执行文件；安装器不得把未验证产物留在最终路径。

## 支持平台与能力声明

首个正式支持矩阵只有：

| 平台 | 架构 | 支持级别 |
| --- | --- | --- |
| macOS | Apple Silicon / arm64 | 正式支持 |
| Windows WSL2 Ubuntu | Linux x64 | 正式支持 |

原生 Windows、任意 Linux 发行版和 Intel Mac 不属于首发支持范围。底层代码存在的其他 platform capability 不能自动升级为公开支持承诺。

README 和 Release 不得声称应用层端到端加密、工作区/Git/SSH/credential 同步、零配置远程执行、崩溃后 provider work 自动恢复、完整主机沙箱或所有 plugin 均可安全远程执行。

## 版本与构建来源

Transit 版本跟随构建所基于的上游版本，并增加 fork 序号：

```text
v<upstream-version>-transit.N
```

构建 manifest 必须记录 Transit version、upstream version、Git commit、dirty 状态、target OS/architecture 和构建时间。所有同一 Release 的平台产物必须来自同一个干净提交。

macOS 稳定版必须通过 Developer ID 签名、Apple notarization 和 stapling。缺少这些条件时只能发布源码构建或标记为 prerelease 的二进制，不能称为稳定版。

## 数据与内部兼容性

OpenCode Transit 有意继续使用现有 `opencode` 配置、Session、credential 和缓存命名空间，不迁移用户目录，也不批量重命名内部 package 或 import。这样能保持既有数据和上游兼容，但意味着 OpenCode Transit 与官方 OpenCode 不是完全隔离安装；用户文档必须明确披露这一点。

Transit 专属 credential key、远端对象前缀和新公共标识必须使用 fork-owned 名称，避免与未来上游功能碰撞。该规则不授权迁移现有 Session 数据库或 Protocol 名称。

## 仓库切换

仓库重命名是产品身份实现的管理步骤。切换时必须更新 fork 文档、Issue/PR 模板、Release 链接、GitHub metadata、本地 `origin` URL 和 `dev` tracking branch；`upstream` URL 和只读策略不变。不能仅依赖 GitHub 的旧地址重定向作为永久配置。

## 验收

1. README 首屏包含产品定位、上游链接和非官方声明。
2. `opencode-transit` 可以安装、升级和报告可追溯版本，且不覆盖 `opencode`。
3. 兼容期内 `opencode-rexd` 明确告警后正确转发。
4. macOS 与 WSL2 的 Release 产物来自同一干净提交并通过 manifest/hash 校验。
5. macOS 稳定版通过签名、公证与 stapling；条件不足时发布流程拒绝 stable。
6. 内部 package、Protocol 和数据目录保持兼容，文档不暗示完全隔离。
7. 所有公开能力声明与已实现、已验收的支持矩阵一致。
