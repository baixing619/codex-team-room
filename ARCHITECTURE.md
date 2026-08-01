# Architecture

## 设计目标

Codex Team Room 把“项目”作为共享边界，把“成员”作为可配置执行者，把“历史任务”作为只读依据。公共房间状态不修改原始 Codex 会话。

```mermaid
flowchart LR
  UI[Team Room UI] --> State[Local room state]
  UI --> Bridge[Local metadata bridge]
  Bridge --> Index[Codex session index]
  Index --> Threads[Existing tasks]
  State --> Knowledge[Shared knowledge]
  State --> Agents[Roles and model config]
  Agents --> Gate[Participation decision]
  Gate --> Approval[Approval and write lock]
  Approval -. 0.2 runtime adapter .-> AppServer[Codex App Server]
```

## 当前实现

- `src/`：React 界面、成员配置、发言判断、本地状态和审批交互。
- `server/codexSessionIndex.mjs`：只读扫描本机 Codex 会话索引，并过滤内部上下文消息。
- `server/codexAppServerRuntime.mjs`：可替换的 App Server JSONL-RPC 适配层；把成员模型、推理强度、沙箱和一次性审批映射到独立 Codex 线程。
- `server/teamRoomRuntimeManager.mjs`：真实/模拟模式管理、成员线程复用、事件回流、审批队列和服务端单写入锁。
- `server/viteCodexBridge.mjs`：仅开发模式启用的本地 HTTP 桥接层。
- `worker/`：静态托管适配器；静态发布不接触用户本机数据。

## 数据边界

房间配置和公共知识保存在浏览器 `localStorage`。Codex 会话保持在原路径，Team Room 不移动、不改写也不删除它们。打开历史对话时最多返回最近 60 条可见消息，单条文本最多 6000 字符。

## 真实运行时接入计划

`RuntimeAdapter` 协议、安全映射和设置页显式启用流程已经落地，并由假 App Server 回归测试覆盖：

1. 每个成员映射一个独立 Codex thread，并携带各自的模型和推理配置。
2. 总控把公共消息写入共享事件流，成员根据参与规则决定是否创建 turn。
3. 只读工具可直接执行；写入或外部副作用工具必须进入审批队列。
4. 同一项目最多一个成员持有写入锁；完成、拒绝或超时后释放。
5. 公开共享的知识条目与成员私有推理分离，避免把隐藏系统上下文暴露给其他成员。
6. 真实运行时事件通过本地轮询回流；静态部署没有启动本机进程的端点。

实现面向 Codex App Server 的公开协议，不修改 Codex Desktop 安装目录，因此软件升级不会覆盖 Team Room。下一阶段将增加协议能力协商、断线重连和流式消息聚合。
