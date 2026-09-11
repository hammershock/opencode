# 面向人类阅读的文档

本规范适用于面向用户、潜在贡献者和安全问题报告者的文档。RFC 继续负责长期产品与架构决策，Issue 负责任务状态；面向人类的文档只解释当前产品，不成为第二套路线图或实现台账。

英文文档是规范源。面向公众的顶级文档应提供使用 `.zh.md` 后缀的简体中文对应版本。内部开发说明和 RFC 不要求翻译。仓库根目录只保留 `README.md` 与 `README.zh.md`，其他受众或任务文档应放入 `docs/`。

## README 契约

根 README 应让新读者依次回答：

1. 这是什么产品？
2. 它与上游 OpenCode 是什么关系？
3. 为什么要使用它？
4. 哪些平台和功能得到实际支持？
5. 如何安装并获得帮助？

README 应聚焦产品认识和首次使用。详细教程、架构、故障排查和协议材料应移入链接文档。中英文 README 的产品声明、限制、链接与章节顺序必须一致，文字可以按语言习惯改写而不必逐字翻译。

所有派生项目 README 必须在第一个安装命令之前放置以下声明或语义等价内容：

> OpenCode Transit 是基于 OpenCode 构建的独立项目。它不是由 OpenCode 团队开发、认可或维护的项目，也与该团队不存在隶属关系。

其中 `OpenCode` 必须链接到上游仓库，并保留上游版权和许可证归属。

## 结构与产品声明

默认结构为：品牌区和语言切换、一句话定位、非官方声明、有效 Badge、一张概览图、重点功能、快速开始、平台与支持表、文档与帮助、贡献、安全、上游致谢和许可证。

- 在完整安装选项之前展示产品的核心差异。
- 实验性或 Beta 功能必须在首次提及时标注，不能只放在脚注里。
- 只描述已观察到的行为和明确支持范围。存在代码路径、原型或一次本地成功运行不等于正式平台支持。
- 当读者可能合理误解时，明确写出安全、同步、远程执行和平台方面的重要非目标。
- 除非具有定义明确且持续验证的契约，否则不得使用“安全”“零崩溃”“零配置”“全平台可用”等绝对表述。
- 当 fork 行为不同时，不复制上游营销文案。

## Badge 与视觉资产

根 README 最多使用四个 Badge。每个 Badge 必须指向本 fork，并表达 Release、CI、许可证或支持平台等可操作事实。不得让上游 CI、包下载量、Discord 或 Release Badge 看起来像是在描述本 fork。

长期使用的视觉资产应存入仓库并使用相对路径。Logo 和图表优先使用 SVG，截图使用压缩后的 WebP 或 PNG。提供有效的替代文本和明确显示尺寸，并在 GitHub 明暗主题及窄屏下检查 README。

品牌资产必须原创并与上游明显区分。截图和录屏只使用脱敏 fixture，不得包含凭据、token、私有主机名、个人路径、账号标识或生产 Session 内容。根 README 通常最多包含一张 Hero/概览图与三张功能图。

## 链接、语言与可访问性

- 使用有意义的链接文字；仓库文件使用稳定的相对链接，外部网站使用 HTTPS。
- 不链接尚未发布的页面或产物；合入前验证锚点和图片路径。
- 使用清晰、包容的语言、短章节和有意义的标题；替代文本应描述图片传达的信息。
- 普通 Markdown 足以表达时，不用文字截图代替。
- 产品声明、支持承诺、安装命令或安全报告入口变化时，中英文公开文档必须在同一个 PR 中更新。

## 审查清单

- 产品声明符合已接受 RFC 和当前验证行为。
- 上游关系和非官方声明足够醒目。
- 安装命令只指向 fork 产物且不覆盖 `opencode`。
- 支持平台和功能成熟度明确。
- 中英文公开文档语义一致。
- Badge、链接、锚点、图片、替代文本和窄屏渲染正确。
- 不含秘密、个人数据、机器特定路径或外部登录状态。
- 贡献和安全链接指向 fork 而不是上游。

## 参考资料

- [GitHub：关于 README](https://docs.github.com/zh/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes)
- [Open Source Guides：启动一个开源项目](https://opensource.guide/zh-hans/starting-a-project/)
- [Standard Readme 规范](https://github.com/RichardLitt/standard-readme/blob/master/spec.md)
- [VSCodium](https://github.com/VSCodium/vscodium)：清晰的派生项目定位
- [uv](https://github.com/astral-sh/uv)、[aider](https://github.com/Aider-AI/aider) 和 [fzf](https://github.com/junegunn/fzf)：紧凑重点与视觉层级
- [frp](https://github.com/fatedier/frp)：持续维护的中英文入口
