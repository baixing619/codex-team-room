# Codex Team Room

一个本地优先的 Codex 多成员项目协作界面。它把同一项目下的历史对话、团队公共聊天、知识条目、成员职责、模型配置与执行审批集中到一个房间里。

## 让 Codex 帮你安装

下载项目后，把 [CODEX_SETUP.md](CODEX_SETUP.md) 拖进 Codex。Codex 会先询问项目目录，然后在你确认后完成本地初始化、CLI 检查、验证和个人私有 Sites 创建。

私有 Sites 适合从手机访问，但不会直接暴露或连接电脑的本地端口。当前版本中，真实 Codex 成员运行在电脑本地页面；跨设备实时控制需要后续的安全设备配对通道。

> 当前版本是可交互的 `0.1.0` 本地原型。历史 Codex 对话读取已经接通；默认使用不会执行命令的确定性模拟。检测到独立 Codex CLI 时，用户可以在设置页明确确认后启用真实成员运行时。

## 现在可以做什么

- 扫描本机 Codex 会话元数据，并按项目归类。
- 把已有项目接入为房间，继续查看原来的对话。
- 仅在用户点开某条历史对话时读取其可见消息。
- 将选定历史对话挂入当前房间的公共知识上下文。
- 为总控、开发、审核、资料四个成员分别配置模型、推理强度、职责和权限。
- 根据提及与职责关键词决定成员发言或静默。
- 用一次性审批和单写入锁演示受控命令执行流程。
- 检测独立 Codex CLI；显式启用后，按成员模型、推理强度和权限创建并复用独立 App Server 线程。
- 把真实成员回复、任务完成和命令审批事件回流到公共群聊。
- 在服务端执行单写入锁，阻止两个成员同时获批修改同一项目。
- 在浏览器本地存储房间配置；导出时自动排除聊天记录与命令记录。

## 本地运行

需要 Node.js 20 或更新版本。

```powershell
npm install
npm run dev
```

默认会启动 Vite 本地服务。开发模式下，本地桥接层读取用户自己的 `CODEX_HOME`（未设置时为用户目录下的 `.codex`）。静态构建不包含本机桥接能力，会自动进入私人云端界面模式，不会直接连接电脑上的 App Server。

为防止局域网设备访问项目路径，本地桥接默认只监听 `127.0.0.1`。只有明确设置 `TEAM_ROOM_HOST` 时才会改变监听地址；公开部署不应启用本地桥接。

```powershell
npm test
npm run build
npm run release:check
```

## 启用真实成员运行时

Team Room 不捆绑 Codex 可执行文件。需要真实成员线程时，请按 [OpenAI 官方 Codex CLI 安装说明](https://help.openai.com/en/articles/11096431) 单独安装并登录：

```powershell
npm install -g @openai/codex
codex login
codex login status
```

Windows 上通过 npm 安装的官方 x64/ARM64 平台二进制会被自动识别。确认设置页显示 CLI 可用后，仍需由用户点击“启用真实成员”才会启动 App Server；Team Room 不会因检测到 CLI 而自动执行任务。

## 隐私边界

- 不上传项目文件、对话、令牌、Cookie 或账号信息。
- 首页扫描仅读取会话元数据；对话正文按需读取。
- 不读取 Codex 的认证文件。
- 仓库不包含任何用户会话、真实项目数据或本机绝对路径。
- 公开发布前必须通过 `npm run release:check`。

更完整的说明见 [PRIVACY.md](PRIVACY.md) 和 [SECURITY.md](SECURITY.md)。

## 架构与路线

当前结构与真实运行时接入边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。0.2 版本计划强化断线恢复、协议版本兼容、流式消息合并和跨房间运行时隔离。

## 开源许可

本项目原创代码采用 [MIT License](LICENSE)。第三方依赖和设计工具来源分别遵循各自许可证，完整清单由 `npm run licenses` 生成到 `THIRD_PARTY_NOTICES.md`。项目不会复制第三方产品代码、私有素材或 Codex 可执行文件。

## 贡献

欢迎提交 issue 和 pull request。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
