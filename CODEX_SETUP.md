# 把这个文件拖进 Codex

这是 Codex Team Room 的个人安装入口。下载或解压项目后，把本文件拖进 Codex；你只需要提供一次项目目录，并确认必要的安装和私人站点授权。

## 安装后你会得到

- 电脑入口：`http://127.0.0.1:4174/`，只监听本机。
- 手机入口：只允许你本人登录的私人 Sites，电脑关机时任务留在私人队列。
- Windows 登录后自动恢复本机服务；不用每次重新安装。

> 本机安装可以真正一键完成。创建个人私人站点和设备配对涉及账号权限与一枚本机专用令牌，因此仍会显示一次明确的安全确认；安装器不会读取密码、Cookie 或 Codex 认证文件。

---

<codex_setup_instructions>

你正在为用户安装 Codex Team Room。必须执行确定的安装器，不要临时拼凑 npm、复制依赖目录或读取认证文件。

1. 如果用户尚未提供目录，只问：“Codex Team Room 下载到了哪个文件夹？请把完整目录地址发给我。”
2. 只读确认该目录包含 `install-team-room.cmd`、`package.json`、`package-lock.json`、`src/`、`server/`，且 `package.json.name` 为 `codex-team-room`。不符合就停止，不猜目录、不移动项目。
3. 一次性说明并请求确认：将在该最终目录重建依赖、必要时安装 Node.js LTS 和官方 Codex CLI、构建并做发布安全检查、启动仅监听 `127.0.0.1` 的本机服务、设置当前用户登录后的自动启动；随后创建仅当前所有者可访问的个人 Sites 和设备配对。明确说明不会读取或输出认证文件、令牌、聊天记录和项目内容。
4. 用户确认后，在该目录运行以下唯一的本机安装入口：

   ```powershell
   .\install-team-room.cmd --no-open --no-pause
   ```

   安装器会使用 `npm ci` 按锁文件重建依赖，因此即使下载目录曾被复制或移动，也不会复用损坏的 `node_modules` 软链接。不要先在别处安装再复制成品目录。
5. 如果 Codex 的受控命令环境拒绝启动安装器，不要检查 `auth.json`、Windows 凭据或浏览器登录状态，也不要把它误报为“未登录”。请用户在资源管理器中双击根目录的 `install-team-room.cmd`；看到“安装完成”后继续第 6 步。
6. 安装器成功才继续。只核对：
   - `GET http://127.0.0.1:4174/api/health` 返回 `ok: true`，且 `serviceRoot` 等于用户给出的安装目录；
   - `GET http://127.0.0.1:4174/api/runtime/status` 返回 `available: true`。
   不运行任何仅凭认证文件推断登录状态的命令，也不读取认证文件。CLI 登录是否真实有效由第 12 步的实际 Codex 回合验证。
7. 在调用任何 Sites 站点读取、保存或部署前，运行：

   ```powershell
   npm run site:prepare-personal
   ```

   这会从当前下载副本移除原作者公开仓库携带的 `project_id`，但保留 D1/R2 绑定名称。绝不尝试访问、复用或更新原作者的站点。
8. 使用 Sites 创建一个全新的个人站点，立即把返回的 `project_id` 写入当前副本的 `.openai/hosting.json`。执行生产构建并保存版本；仅使用私人部署，不得设为公开。
9. 部署后核对访问策略：当前用户必须是唯一所有者，用户组为 0，外部访客为 0。不满足则停止，不能继续配对。
10. 告诉用户：“将创建一枚只供这台电脑访问你私人站点的令牌；它只保存在本机，不会进 Git 或站点源码。”取得肯定答复后，创建站点专用 SIWC 绕过令牌。把 `siteUrl`、令牌、用户确认的默认项目目录和设备名称以 JSON 从标准输入传给 `npm run pair:configure`。不得把令牌写进命令行参数或输出。
11. 读取 `.team-room/sites-environment.json`，把其中 `TEAM_ROOM_DEVICE_SECRET` 作为 Sites 生产 secret 写入；无论写入或部署是否成功，都在 `finally` 中删除该临时文件。保留 Git 忽略的 `.team-room/pairing.json`。重新构建、保存并私人部署，然后调用：

   ```powershell
   Invoke-RestMethod -Method Post http://127.0.0.1:4174/api/pair/reload
   ```

12. 只做一次必要的真实验收：
   - `/api/pair/local-status` 必须是 `configured: true`、`running: true`、`lastError: null`；
   - 私人站点显示本机在线；
   - 发送一条“不执行命令、不写文件，只回复 TEAM_ROOM_READY”的测试消息，确认私人队列、独立 Codex 回合和手机回传全部成功。
   不自动批准任何命令。失败时立即停止并报告具体失败阶段，不继续堆叠测试。
13. 最终只交付本地地址、个人私人站点地址和 [详细图文教程](docs/USER_GUIDE.md)。提醒用户：项目移动到新目录后需要再次运行 `install-team-room.cmd`；不要复制已经生成的 `node_modules`、`.team-room` 或原作者 `.openai/hosting.json` 到另一台电脑。
14. 永远不提交 `.team-room/`、`.codex`、认证文件、令牌、Cookie、数据库、本机绝对路径、用户聊天记录或项目内容。每位用户必须有自己的私人站点、设备密钥和配对文件。

</codex_setup_instructions>
