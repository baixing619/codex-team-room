# 把这个文件拖进 Codex

这个文件用于让 Codex 帮你初始化自己的 Codex Team Room。你不需要先会配置命令行。

## 你要做什么

1. 下载或克隆 Codex Team Room 项目。
2. 把本文件拖进 Codex 对话框。
3. Codex 会问你“项目目录在哪里”。把下载后的项目文件夹地址发给它。
4. Codex 检查目录正确后，会一次性说明将要进行的安装、验证和私有站点创建操作，并等待你确认。
5. 完成后，Codex 会给你两个入口：
   - 电脑本地入口：连接你自己的 Codex CLI，可启用真实成员。
   - 私有 Sites 入口：登录后可从手机访问，仅限站点所有者，默认不公开。

> 安全说明：私有 Sites 页面不会自动暴露你电脑上的端口、项目文件、历史对话或登录凭据。当前版本的手机私有站点用于查看和配置 Team Room；手机要实时驱动家中电脑上的 Codex，需要另行启用经过认证的设备配对通道。

---

<codex_setup_instructions>

你正在帮助用户安装 Codex Team Room。请按以下顺序执行，不要跳过目录确认、隐私检查或用户授权。

1. 如果用户尚未给出项目目录，只问一句：“Codex Team Room 下载到了哪个文件夹？请把完整目录地址发给我。”
2. 收到目录后，先只读确认它包含 `package.json`、`.openai/hosting.json`、`src/`、`server/`，并确认 `package.json.name` 为 `codex-team-room`。不符合时停止并请用户重新选择，绝不在猜测目录中安装。
3. 说明将进行以下操作，并请求一次明确确认：
   - 在确认的项目目录安装项目依赖；
   - 检查并按 OpenAI 官方方式安装或升级 `@openai/codex` CLI；
   - 检查 Codex 登录状态，但不读取或输出认证文件；
   - 运行测试、生产构建和发布安全检查；
   - 启动仅监听 `127.0.0.1` 的本地 Team Room；
   - 使用 Sites 创建仅站点所有者可访问的个人私有站点。
4. 用户确认后，在项目目录执行 `npm install`、`npm test`、`npm run build`、`npm run release:check`。任何一步失败都先修复并重跑，不要把失败状态说成完成。
5. 检查 `codex --version` 和 `codex login status`。如果没有官方 CLI，使用 `npm install -g @openai/codex`；如果需要登录，让用户在可见登录界面完成，不索要令牌或密码。
6. 启动本地服务时只绑定 `127.0.0.1`。打开本地页面，确认 `/api/health` 正常且 `/api/runtime/status` 能识别独立 Codex CLI。真实运行时必须继续由用户在设置页明确点击启用。
7. 使用 Sites 插件发布个人站点：
   - 先读取 `.openai/hosting.json`。
   - 如果没有 `project_id`，创建一个新站点并立即写回该文件。
   - 如果已有 `project_id`，先确认当前用户对该站点有权限；若该 ID 来自原作者且当前用户无权访问，说明原因，获得确认后移除旧 ID，再为当前用户创建新的个人站点。
   - 构建成功后保存版本，优先使用私有部署；不得改成公开访问。
   - 私有部署完成后核对访问策略只有当前所有者，没有用户组或外部访客。
8. 最终交付电脑本地地址和个人私有 Sites 地址，并明确区分：本地地址连接本机 Codex；私有 Sites 地址可从手机访问，但在安全设备配对功能完成前不会直接连接本机 App Server。
9. 不把 `.codex` 会话、认证文件、项目内容、令牌、Cookie、数据库、本机绝对路径或用户聊天记录提交到 Git 或部署包。

</codex_setup_instructions>

