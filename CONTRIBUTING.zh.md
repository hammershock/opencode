# 为 OpenCode Transit 贡献

[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh.md)

感谢你帮助改进 OpenCode Transit。我们欢迎聚焦的缺陷修复、文档、测试、兼容性工作，以及边界清晰的产品改进。

> [!IMPORTANT]
> OpenCode Transit 是基于 [OpenCode](https://github.com/anomalyco/opencode) 构建的独立项目。它并非由 OpenCode 团队开发、认可或维护，与 OpenCode 团队也不存在隶属关系。

## 从 Issue 开始

每个 Pull Request 都必须关闭[本仓库](https://github.com/hammershock/opencode-transit/issues)中的一个 Issue。开始编码前：

1. 搜索开放与已关闭的 Issue，确认没有相同问题。
2. 选择对应的[缺陷报告](https://github.com/hammershock/opencode-transit/issues/new?template=bug-report.yml)、[功能建议](https://github.com/hammershock/opencode-transit/issues/new?template=feature-request.yml)或[问题咨询](https://github.com/hammershock/opencode-transit/issues/new?template=question.yml)。
3. 描述一个可观察的结果、相关边界和验证方法。
4. 实现产品功能前等待维护者确认范围；接手 Issue 前先留言，避免重复工作。

不要公开提交安全漏洞 Issue，请遵循 [SECURITY.zh.md](SECURITY.zh.md)。

如果功能会改变长期有效的产品或架构契约，就需要先有已接受的 RFC。维护者会说明何时适用；缺陷修复或文档纠正通常不需要新增 RFC。

### 选择正确的仓库

本仓库负责 Transit 专属行为：Location、SSH/Rexd、会话放置与恢复、同步、Provider 用量、Fork 自有 TUI 命令、Skills、发布入口，以及它们与上游 OpenCode 的集成。

如果问题在上游 OpenCode 中原样复现，且与 Transit 边界无关，请先搜索[上游 Issue Tracker](https://github.com/anomalyco/opencode/issues)。不要在两个仓库重复提交同一报告；当上游改动也与本项目有关时，应明确说明两者关系。

## 建立工作树

你需要 Git，以及根目录 [`package.json`](package.json) 声明的 Bun 版本。先在 GitHub Fork 本仓库，克隆你自己的 Fork，再把本项目添加为 remote：

```bash
git clone https://github.com/YOUR-GITHUB-LOGIN/opencode-transit.git
cd opencode-transit
git remote add transit https://github.com/hammershock/opencode-transit.git
```

从最新的 `dev` 创建专用工作树。分支名最多包含三个用连字符连接的短词，不要使用 `feat/` 之类的类型前缀，也不要包含个人名称。

```bash
git fetch transit dev
git worktree add ../opencode-transit-fix-example -b fix-example transit/dev
cd ../opencode-transit-fix-example
bun install --frozen-lockfile
```

请把 `fix-example` 替换为你的语义化分支名。

一个 Issue 对应一个分支、一个工作树和一个 Pull Request。不要把重构、依赖升级、无关生成文件变化或上游同步混进当前改动。完整规则参见 [`docs/development-workflow.md`](docs/development-workflow.md)。

## 开发改动

使用以下命令，让 Transit 在一次性项目目录中运行：

```bash
bun dev /path/to/disposable/project
```

遵循根目录 [`AGENTS.md`](AGENTS.md)，以及修改文件所在包内适用的 `AGENTS.md`。尤其要注意：

- 保持改动精简，在已接受的 Transit 边界之外保留上游行为；
- 适用时优先使用 Bun API 与精确的推断类型；
- 避免导入别名、星号导入、不必要的解构、`any`、变量重赋值和宽泛的 `try`/`catch`；
- 绝不提交凭据、私有主机名、个人路径、账户标识或生产会话内容；
- 只为意外约束添加注释，不解释显而易见的控制流。

公共 API 变化后，请通过归属它的脚本重新生成输出，不要直接编辑生成文件：

- 旧版 JavaScript SDK：`./packages/sdk/js/script/build.ts`
- Protocol 或 Server `HttpApi`：在 `packages/client` 中运行 `bun run generate`

## 验证改动

先运行范围最小、与改动直接相关的检查。测试不能从仓库根目录运行；TypeScript 包应使用 `bun typecheck`，不要直接运行 `tsc`。

```bash
# 示例：包级类型检查与一个聚焦测试
cd packages/opencode
bun typecheck
bun test path/to/affected.test.ts
```

| 改动                                    | 贡献者提供的证据                                                   |
| --------------------------------------- | ------------------------------------------------------------------ |
| 文档或模板                              | 格式检查、本地链接与锚点、Markdown 渲染或表单校验                  |
| TypeScript 逻辑                         | 受影响包的 `bun typecheck` 与聚焦的单元、契约或集成测试            |
| TUI 行为                                | 聚焦检查，以及来自可用受支持控制端的截图或录屏                     |
| Location、Rexd、Shell、环境、认证或同步 | 聚焦自动化检查，以及在你能使用的每个受支持控制端上运行相关真实流程 |
| 生成的 API 或 SDK                       | 生成命令、生成差异审查与受影响包检查                               |

请使用经过清理的一次性工作区、会话、目标标签与测试账户。不要把凭据值或解密后的同步数据放进日志或截图。涉及 UI 时，应按需提供改动前后证据。

完整测试阶梯与验收矩阵参见 [`docs/testing-workflow.md`](docs/testing-workflow.md)。

### 设备责任

外部贡献者不需要拥有本项目的两台标准设备。请在自己能使用的受支持平台上运行相关流程，并如实列出所有未运行的平台或场景，不要猜测结果。缺少设备覆盖不妨碍你创建 Pull Request。

对于功能改动，维护者会在合入前使用同一个候选提交，完成 Mac Apple Silicon 与 `mywindows`/WSL2 的必需验收。这是项目的合入门禁，并不要求贡献者购买、借用或管理项目硬件。纯文档改动通常不需要运行时设备验收。

## 创建 Pull Request

Pull Request 应以 [`hammershock/opencode-transit:dev`](https://github.com/hammershock/opencode-transit/tree/dev) 为目标，而不是 `main` 或上游 OpenCode。

- 使用 `Closes #123` 关联且只关闭一个主要 Issue。
- 标题遵循约定式提交，例如 `fix(tui): preserve remote completion state` 或 `docs: clarify WSL2 setup`。
- 简洁说明结果、改动为何有效、兼容或安全边界，以及验证结果。
- 勾选已运行的平台，并明确列出验证缺口。
- 用户可见的 TUI 改动需要附截图或录屏。
- 保持提交便于审查；维护者可能压缩等价于单提交的改动。

无论工作是手写还是使用了自动化辅助，你都需要理解改动、核验其中的声明，并回答审查问题。生成内容的数量不是证据；简洁且可复现的说明才是。

## 审查与完成

审查可能要求缩小范围、增加回归覆盖、补充 RFC 决策、重新生成制品，或由维护者完成设备验证。Pull Request 只有在满足以下条件后才可以合入：

- 对应 Issue 与验收项均已满足；
- 相关自动化检查通过；
- 贡献者与维护者的验证缺口已经解决，或明确不适用；
- 生成文件保持最新；
- 差异与证据中没有秘密或私有机器数据；
- 面向用户的英文与简体中文文档保持语义一致。

如果 Issue 或 Pull Request 自动检查指出必填信息缺失，请在七天内更新原条目。自动化只判断完整性与可复现性，不会仅仅因为作者使用了辅助工具而拒绝工作。

维护者负责最终集成、跨设备验收与发布资格确认；贡献者会保留被接受工作的作者署名。
