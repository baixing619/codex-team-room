import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsClockwise,
  At,
  BookOpenText,
  CalendarBlank,
  Camera,
  CaretDown,
  ChatCircle,
  ChatsCircle,
  Check,
  CheckCircle,
  Code,
  Database,
  Eye,
  File as FileIcon,
  FolderOpen,
  GearSix,
  GithubLogo,
  Hash,
  Info,
  LockKey,
  MagnifyingGlass,
  Paperclip,
  PaperPlaneTilt,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { DEFAULT_THREADS, MODEL_OPTIONS } from "./data/defaults.js";
import { decideParticipation } from "./lib/participation.js";
import { addRoomMember, createProjectMember, createRoomAgents, createSafeMemberPrompt, removeRoomMember, replaceRoomMember } from "./lib/roomAgents.js";
import { loadState, resetState, saveState } from "./lib/storage.js";
import { buildRoomSharedContext, formatAttachmentSize, validateSelectedFiles } from "./lib/taskPayload.js";
import { applyCloudSnapshot, createCloudSnapshot } from "./lib/cloudState.js";

const VIEW_ITEMS = [
  { id: "knowledge", label: "知识库", icon: BookOpenText },
  { id: "agents", label: "成员配置", icon: UsersThree },
  { id: "settings", label: "设置", icon: GearSix },
];

const PERMISSION_LABELS = {
  "read-only": "只读分析",
  "request-write": "可申请写入",
  coordinate: "协调建议",
};

function classNames(...values) {
  return values.filter(Boolean).join(" ");
}

function isPrivateCloudHost() {
  if (typeof window === "undefined") return false;
  return !["127.0.0.1", "localhost"].includes(window.location.hostname);
}

function nowLabel() {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function formatRelativeDate(value) {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "历史记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message || value.error || "请求失败");
  return value;
}

async function requestRemoteIndex(type, body = {}) {
  const created = await postJson("/api/remote/index-requests", { type, ...body });
  const initial = created.indexRequest;
  if (initial?.status === "completed") return initial.result;
  if (initial?.status === "failed") throw new Error(initial.error || "本机索引读取失败");
  const requestId = initial?.id;
  if (!requestId) throw new Error("无法创建本地索引请求");

  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, attempt < 4 ? 350 : 750));
    const response = await fetch(`/api/remote/index-requests/${encodeURIComponent(requestId)}`);
    const value = await response.json();
    if (!response.ok) throw new Error(value.message || value.error || "读取本地索引失败");
    if (value.indexRequest?.status === "completed") return value.indexRequest.result;
    if (value.indexRequest?.status === "failed") throw new Error(value.indexRequest.error || "本机索引读取失败");
  }
  throw new Error("读取本机索引超时，请确认电脑保持在线后重试");
}

function AgentAvatar({ agent, size = "medium" }) {
  const safeAgent = agent || { name: "已移除成员", avatar: "/assets/agents/agent-researcher.png" };
  return (
    <img
      className={classNames("agent-avatar", `agent-avatar--${size}`)}
      src={safeAgent.avatar}
      alt={`${safeAgent.name}成员头像`}
    />
  );
}

function Sidebar({
  rooms,
  activeRoom,
  threads,
  activeThreadId,
  activeView,
  bridge,
  pairing,
  onSelectRoom,
  onSelectThread,
  onOpenImport,
  onRemoveRoom,
  onSelectView,
}) {
  const privateCloud = isPrivateCloudHost();
  const pairedOnline = privateCloud && pairing?.online;
  const connectionLabel = bridge?.ok
    ? "本地 · 已连接"
    : pairedOnline
      ? `私人云端 · ${pairing.device?.label || "本机"}在线`
      : privateCloud && pairing?.paired
        ? "私人云端 · 本机离线"
        : privateCloud
          ? "私人云端 · 本机未配对"
          : "本地 · 未连接";
  return (
    <aside className="sidebar">
      <div className="brand-block">
        <div className="brand-name">Codex Team Room</div>
        <div className="connection-line">
          {connectionLabel}
          <span className={classNames("status-dot", (bridge?.ok || pairedOnline) ? "status-dot--green" : "status-dot--gray")} />
        </div>
      </div>

      <button className="outline-action" type="button" onClick={onOpenImport}>
        <Plus size={18} weight="bold" />
        接入现有项目
      </button>

      <section className="sidebar-section">
        <div className="sidebar-label">项目房间</div>
        <div className="room-list">
          {rooms.map((room) => (
            <div className="room-item" key={room.id}>
              <button
                className={classNames("sidebar-row", room.id === activeRoom.id && activeView === "chat" && "is-active")}
                type="button"
                onClick={() => onSelectRoom(room.id)}
                title={room.path}
              >
                <ChatsCircle size={18} />
                <span>{room.name}</span>
              </button>
              {room.source !== "local" ? (
                <button className="room-remove room-remove--persistent" type="button" aria-label={`移除${room.name}`} title="仅从 Team Room 移除" onClick={() => onRemoveRoom(room)}>
                  <X size={15} weight="bold" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      <section className="sidebar-section sidebar-section--threads">
        <div className="sidebar-label sidebar-label--inline">
          <span>对话线程</span>
          <MagnifyingGlass size={18} />
        </div>
        <div className="thread-list">
          {threads.map((thread) => (
            <button
              key={thread.id}
              className={classNames("thread-row", activeView === "chat" && activeThreadId === thread.id && "is-active")}
              type="button"
              onClick={() => onSelectThread(thread)}
            >
              {thread.id === "global" ? <Hash size={16} weight="bold" /> : <ChatCircle size={16} />}
              <span className="thread-title">{thread.id === "global" ? "团队调度台" : thread.title}</span>
              <span className="thread-time">{thread.time || formatRelativeDate(thread.updatedAt)}</span>
            </button>
          ))}
        </div>
      </section>

      <nav className="utility-nav" aria-label="项目工具">
        {VIEW_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={classNames("utility-row", activeView === id && "is-active")}
            onClick={() => onSelectView(id)}
          >
            <Icon size={19} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function RoomHeader({ room, rooms, activeView, activeThread, onSelectRoom }) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef(null);
  useEffect(() => {
    if (!switcherOpen) return undefined;
    const closeIfOutside = (event) => {
      if (!switcherRef.current?.contains(event.target)) setSwitcherOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setSwitcherOpen(false);
    };
    document.addEventListener("pointerdown", closeIfOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeIfOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [switcherOpen]);
  const titles = {
    knowledge: ["知识库", "保存团队确认过的事实、决定和安全边界。"],
    agents: ["成员配置", "为每位成员单独配置职责、模型和权限。"],
    settings: ["项目设置", "管理本地连接、隐私和开源发布状态。"],
  };
  const title = activeView === "chat" ? activeThread?.id === "global" ? "团队调度台" : activeThread?.title || "团队调度台" : titles[activeView]?.[0];
  const subtitle =
    activeView === "chat"
      ? activeThread?.id && activeThread.id !== "global"
        ? "历史对话以只读方式打开，可选择挂入团队公共上下文。"
        : "消息只路由给当前项目中需要发言的成员任务，不会群发到历史对话。"
      : titles[activeView]?.[1];

  return (
    <header className="room-header">
      <div className="room-heading">
        <div className="room-title-line">
          <div className="room-switcher-wrap" ref={switcherRef}>
            <button className="room-switcher" type="button" aria-haspopup="menu" aria-expanded={switcherOpen} onClick={() => setSwitcherOpen((value) => !value)}>
              {room.name}
              <CaretDown size={15} weight="bold" />
            </button>
            {switcherOpen ? (
              <div className="room-switcher-menu" role="menu" aria-label="切换项目房间">
                {rooms.map((candidate) => (
                  <button
                    key={candidate.id}
                    className={classNames("room-switcher-option", candidate.id === room.id && "is-current")}
                    type="button"
                    role="menuitemradio"
                    aria-checked={candidate.id === room.id}
                    onClick={() => { onSelectRoom(candidate.id); setSwitcherOpen(false); }}
                  >
                    <FolderOpen size={16} />
                    <span>{candidate.name}</span>
                    {candidate.id === room.id ? <Check size={16} weight="bold" /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <span className="header-divider" />
          <div className="channel-title">
            {activeView === "chat" ? <Hash size={17} weight="bold" /> : null}
            <span>{title}</span>
          </div>
        </div>
        <p>{subtitle}</p>
      </div>
      <div className="header-actions">
        <span>8月1日</span>
        <CalendarBlank size={19} />
        <span className="header-divider header-divider--short" />
      </div>
    </header>
  );
}

function MessageItem({ message, agents }) {
  if (message.kind === "divider") {
    return (
      <div className="date-divider">
        <span />
        <strong>{message.text}</strong>
        <span />
      </div>
    );
  }
  if (message.kind === "system") {
    return (
      <div className="system-message">
        <Sparkle size={17} />
        <span>{message.text}</span>
        {message.time ? <time>{message.time}</time> : null}
      </div>
    );
  }
  if (message.kind === "user") {
    return (
      <article className="message message--user">
        <div className="user-avatar">你</div>
        <div className="message-body">
          <div className="message-meta">
            <strong>你</strong>
            <time>{message.time}</time>
          </div>
          {message.text ? <p>{message.text}</p> : null}
          {message.attachments?.length ? (
            <div className="message-attachments">
              {message.attachments.map((attachment) => (
                <span key={attachment.id || attachment.name}><FileIcon size={16} />{attachment.name}<small>{formatAttachmentSize(attachment.size)}</small></span>
              ))}
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  const agent = agents.find((item) => item.id === message.agentId) || { id: message.agentId, name: "已移除成员", avatar: "/assets/agents/agent-researcher.png" };
  return (
    <article className="message">
      <AgentAvatar agent={agent} />
      <div className="message-body">
        <div className="message-meta">
          <strong>{agent.name}</strong>
          <time>{message.time}</time>
        </div>
        <p>{message.text}</p>
      </div>
    </article>
  );
}

function CommandCard({ command, agent, writeLock, onInspect, onApprove, onDeny }) {
  const isApproved = command.status === "approved";
  const isCompleted = command.status === "completed";
  const isDenied = command.status === "denied";

  return (
    <div className={classNames("command-card", isApproved && "is-approved", isDenied && "is-denied")}>
      <div className="command-card__top">
        <div>
          <strong>{agent.name}</strong>
          <span>请求执行命令</span>
        </div>
        <time>{command.time}</time>
      </div>
      <div className="command-card__content">
        <h3>{command.title}</h3>
        <p>{command.summary}</p>
        <div className="command-code"><Code size={16} />{command.command}</div>
        <div className="command-facts">
          <span><Database size={16} />目标：{command.target}</span>
          <span>影响：{command.impact}</span>
          <span className="risk-low">● 风险：{command.risk}</span>
        </div>
      </div>
      <div className="command-card__actions">
        <button className="secondary-button" type="button" onClick={() => onInspect(command)}>
          <Eye size={17} />查看详情
        </button>
        <div className="command-decision">
          {command.status === "pending" ? (
            <>
              <button className="primary-button" type="button" onClick={() => onApprove(command)}>
                <LockKey size={17} />允许一次
              </button>
              <button className="secondary-button" type="button" onClick={() => onDeny(command)}>拒绝</button>
            </>
          ) : null}
          {isApproved ? (
            ["runtime", "remote"].includes(command.source)
              ? <span className="decision-label decision-label--success"><ArrowsClockwise className="spin" size={17} />Codex 执行中</span>
              : <span className="command-status-note">等待真实 Codex 返回完成状态</span>
          ) : null}
          {isCompleted ? <span className="decision-label decision-label--success"><CheckCircle size={17} />已完成</span> : null}
          {isDenied ? <span className="decision-label"><X size={17} />已拒绝</span> : null}
        </div>
      </div>
      {writeLock?.agentId === command.agentId ? (
        <div className="write-lock-line"><LockKey size={15} />{agent.name}当前持有项目写入锁</div>
      ) : null}
    </div>
  );
}

function Composer({ value, onChange, onSend, executionMode, onToggleMode, disabled, agents, attachments, onFilesSelected, onRemoveAttachment, sending, connectionLabel }) {
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const cameraInputRef = useRef(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  const insertMention = (agent) => {
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? value.length;
    const end = textarea?.selectionEnd ?? value.length;
    const mention = `@${agent.name} `;
    onChange(`${value.slice(0, start)}${mention}${value.slice(end)}`);
    setMentionOpen(false);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + mention.length, start + mention.length);
    });
  };

  const receiveFiles = (fileList) => {
    onFilesSelected(fileList);
  };

  return (
    <div className="composer-wrap">
      {attachments.length ? (
        <div className="attachment-tray" aria-label="待发送附件">
          {attachments.map((attachment) => (
            <div className="attachment-chip" key={attachment.clientId}>
              {attachment.previewUrl ? <img src={attachment.previewUrl} alt="" /> : <FileIcon size={20} />}
              <span><strong>{attachment.name}</strong><small>{formatAttachmentSize(attachment.size)}</small></span>
              <button type="button" onClick={() => onRemoveAttachment(attachment.clientId)} aria-label={`移除${attachment.name}`}><X size={15} /></button>
            </div>
          ))}
        </div>
      ) : null}
      <div
        className={classNames("composer", disabled && "is-disabled")}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); receiveFiles(event.dataTransfer.files); }}
      >
        <div className="mention-control">
          <button className="composer-tool composer-tool--mention" type="button" aria-label="提及成员" onClick={() => setMentionOpen((open) => !open)} disabled={disabled}><At size={21} /></button>
          {mentionOpen ? (
            <div className="mention-menu" role="menu" aria-label="选择要提及的成员">
              {agents.map((agent) => <button key={agent.id} type="button" role="menuitem" onClick={() => insertMention(agent)}><AgentAvatar agent={agent} /><span><strong>{agent.name}</strong><small>{agent.role}</small></span></button>)}
            </div>
          ) : null}
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files || []);
            if (files.length) receiveFiles(files);
          }}
          placeholder="@ 成员或输入消息，Enter 发送，Shift + Enter 换行"
          rows={1}
          disabled={disabled}
        />
        <input ref={fileInputRef} className="visually-hidden" type="file" multiple accept="image/*,audio/*,text/*,.md,.mdx,.csv,.tsv,.log,.json,.jsonl,.yaml,.yml,.xml,.html,.css,.js,.jsx,.mjs,.cjs,.ts,.tsx,.py,.ps1,.sh,.bat,.cmd,.sql,.toml,.ini,.java,.go,.rs,.c,.h,.cpp,.hpp,.cs,.php,.rb,.swift,.kt,.gradle" onChange={(event) => { receiveFiles(event.target.files); event.target.value = ""; }} />
        <input ref={cameraInputRef} className="visually-hidden" type="file" accept="image/*" capture="environment" onChange={(event) => { receiveFiles(event.target.files); event.target.value = ""; }} />
        <button className="composer-tool" type="button" aria-label="选择文件或照片" title="选择文件或照片" onClick={() => fileInputRef.current?.click()} disabled={disabled}><Paperclip size={22} /></button>
        <button className="composer-tool" type="button" aria-label="拍照" title="拍照" onClick={() => cameraInputRef.current?.click()} disabled={disabled}><Camera size={22} /></button>
        <button
          className={classNames("composer-tool", executionMode && "is-active")}
          type="button"
          aria-label="切换执行申请"
          onClick={onToggleMode}
          title={executionMode ? "成员可申请执行" : "仅讨论"}
        >
          <Code size={22} />
        </button>
        <button className="send-button" type="button" onClick={onSend} disabled={disabled || (!value.trim() && !attachments.length)} aria-label="发送消息">
          {sending ? <ArrowsClockwise className="spin" size={20} /> : <PaperPlaneTilt size={21} weight="fill" />}
        </button>
      </div>
      <div className="composer-caption">
        <span>{connectionLabel} · {executionMode ? "成员可申请写入，仍需逐次审批" : "仅分析，本轮强制只读"} · 支持图片、音频、文本和代码附件</span>
      </div>
    </div>
  );
}

function ChatView({
  messages,
  commands,
  agents,
  writeLock,
  draft,
  executionMode,
  onDraftChange,
  onSend,
  onToggleMode,
  onInspect,
  onApprove,
  onDeny,
  attachments,
  onFilesSelected,
  onRemoveAttachment,
  sending,
  canSend,
  connectionLabel,
}) {
  const endRef = useRef(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages.length, commands.length]);

  return (
    <div className="chat-layout">
      <div className="message-scroll">
        {messages.map((message) => <MessageItem key={message.id} message={message} agents={agents} />)}
        {commands.map((command) => {
          const agent = agents.find((item) => item.id === command.agentId) || { id: command.agentId, name: "已移除成员", avatar: "/assets/agents/agent-researcher.png" };
          return (
            <CommandCard
              key={command.id}
              command={command}
              agent={agent}
              writeLock={writeLock}
              onInspect={onInspect}
              onApprove={onApprove}
              onDeny={onDeny}
            />
          );
        })}
        <div ref={endRef} />
      </div>
      <Composer
        value={draft}
        onChange={onDraftChange}
        onSend={onSend}
        executionMode={executionMode}
        onToggleMode={onToggleMode}
        agents={agents}
        attachments={attachments}
        onFilesSelected={onFilesSelected}
        onRemoveAttachment={onRemoveAttachment}
        sending={sending}
        disabled={!canSend || sending}
        connectionLabel={connectionLabel}
      />
    </div>
  );
}

function HistoryView({ history, loading, error, onAttach, onRefresh }) {
  if (loading) return <div className="center-state"><ArrowsClockwise className="spin" size={28} />正在读取公开消息…</div>;
  if (error) return <div className="center-state center-state--error"><WarningCircle size={28} />{error}</div>;
  if (!history) return <div className="center-state"><ChatCircle size={28} />选择一个历史对话查看。</div>;

  return (
    <div className="history-view">
      <div className="history-banner">
        <div><ShieldCheck size={20} /><span>只读历史：查看不会修改原对话；挂入后会复制可见正文到当前项目共享上下文</span></div>
        <div className="history-actions">
          <button className="secondary-button" type="button" onClick={onRefresh}><ArrowsClockwise size={17} />更新历史</button>
          <button className="primary-button" type="button" onClick={onAttach}>挂入公共上下文</button>
        </div>
      </div>
      <div className="history-scroll" tabIndex={0} aria-label="历史消息滚动区域">
        <div className="history-list">
          {history.messages.length === 0 ? <div className="empty-panel">这个对话没有可导入的公开消息。</div> : null}
          {history.messages.map((message) => (
            <article key={message.id} className={classNames("history-message", `history-message--${message.role}`)}>
              <strong>{message.role === "user" ? "你" : "Codex"}</strong>
              <p>{message.text}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}

function AgentRoster({ agents, onOpenAgent }) {
  return (
    <aside className="agent-panel">
      <div className="agent-panel__title">成员（{agents.length}）</div>
      <div className="agent-roster">
        {agents.map((agent) => (
          <button className="agent-card" type="button" key={agent.id} onClick={() => onOpenAgent(agent.id)}>
            <AgentAvatar agent={agent} size="large" />
            <div className="agent-card__content">
              <div className="agent-name-line">
                <strong>{agent.name}</strong>
                <span className={classNames("role-tag", `role-tag--${agent.color}`)}>{agent.name}</span>
              </div>
              <p>{agent.description}</p>
              <div className="agent-status"><span className={classNames("status-dot", agent.status === "silent" ? "status-dot--gray" : "status-dot--green")} />{agent.statusLabel}</div>
              <div className="agent-model">模型：{MODEL_OPTIONS.find((item) => item.value === agent.model)?.label || agent.model}</div>
            </div>
          </button>
        ))}
      </div>
      <div className="silence-rule">
        <Sparkle size={18} />
        <span><strong>自动静默规则</strong><small>职责无关或无新增信息时不发言</small></span>
      </div>
    </aside>
  );
}

function KnowledgeView({ entries, onAdd }) {
  const [isAdding, setIsAdding] = useState(false);
  const [form, setForm] = useState({ title: "", category: "已确认决定", body: "" });

  const submit = (event) => {
    event.preventDefault();
    if (!form.title.trim() || !form.body.trim()) return;
    onAdd(form);
    setForm({ title: "", category: "已确认决定", body: "" });
    setIsAdding(false);
  };

  return (
    <div className="content-view">
      <div className="content-toolbar">
        <div>
          <span className="eyebrow">公共知识</span>
          <h2>团队共同依据</h2>
        </div>
        <button className="primary-button" type="button" onClick={() => setIsAdding((value) => !value)}><Plus size={17} />新增条目</button>
      </div>

      {isAdding ? (
        <form className="knowledge-form" onSubmit={submit}>
          <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="条目标题" autoFocus />
          <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
            <option>已确认决定</option><option>安全规则</option><option>发布要求</option><option>项目事实</option>
          </select>
          <textarea value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} placeholder="只记录已经确认、未来成员需要共同遵守的信息" rows={4} />
          <div className="form-actions"><button className="secondary-button" type="button" onClick={() => setIsAdding(false)}>取消</button><button className="primary-button" type="submit">保存到公共知识</button></div>
        </form>
      ) : null}

      <div className="knowledge-list">
        {entries.map((entry) => (
          <article className="knowledge-row" key={entry.id}>
            <div className="knowledge-icon"><BookOpenText size={22} /></div>
            <div>
              <div className="knowledge-meta"><span>{entry.category}</span><time>{entry.updatedAt}</time></div>
              <h3>{entry.title}</h3>
              <p>{entry.body}</p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function AgentSettingsView({ agents, onOpenAgent, onAddMember, onRemoveAgent }) {
  return (
    <div className="content-view">
      <div className="content-toolbar">
        <div><span className="eyebrow">项目独立</span><h2>成员与模型</h2></div>
        <div className="content-toolbar-actions"><div className="privacy-chip"><ShieldCheck size={17} />仅影响当前项目</div><button className="primary-button" type="button" onClick={onAddMember}><Plus size={17} />新增成员</button></div>
      </div>
      <div className="agent-settings-list">
        {agents.map((agent) => (
          <div className="agent-settings-row" key={agent.id}>
            <button className="agent-settings-row__main" type="button" onClick={() => onOpenAgent(agent.id)}>
            <AgentAvatar agent={agent} size="large" />
            <div className="agent-settings-main"><strong>{agent.name} · {agent.role}</strong><p>{agent.description}</p></div>
            <div className="agent-settings-fact"><span>模型</span><strong>{MODEL_OPTIONS.find((item) => item.value === agent.model)?.label || agent.model}</strong></div>
            <div className="agent-settings-fact"><span>推理</span><strong>{agent.reasoning}</strong></div>
            <div className="agent-settings-fact"><span>权限</span><strong>{PERMISSION_LABELS[agent.permission] || agent.permission}</strong></div>
            <SlidersHorizontal size={20} />
            </button>
            <button className="agent-settings-remove" type="button" aria-label={`从当前项目移除${agent.name}`} title="只从当前项目移除" onClick={() => onRemoveAgent(agent)}> <X size={18} weight="bold" /> </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsView({ bridge, pairing, runtime, rooms, syncStatus, onConnectRuntime, onDisconnectRuntime, onExport, onReset }) {
  const privateCloud = isPrivateCloudHost();
  return (
    <div className="content-view">
      <div className="content-toolbar"><div><span className="eyebrow">本地优先</span><h2>连接、隐私与开源</h2></div></div>
      <div className="settings-sections">
        <section className="settings-block">
          <div className="settings-icon"><Database size={22} /></div>
          <div className="settings-copy"><h3>本地 Codex 索引</h3><p>默认只扫描会话元数据；只有你打开具体线程时，才读取该线程的可见消息。</p></div>
          <div className={classNames("settings-state", (bridge?.ok || pairing?.online) && "is-good")}>{bridge?.ok ? `${bridge.indexedThreads} 条会话` : privateCloud ? pairing?.online ? `${pairing.device?.label || "本机"}在线` : pairing?.paired ? "本机离线" : "等待本机配对" : "本地索引未连接"}</div>
        </section>
        <section className="settings-block">
          <div className="settings-icon"><FolderOpen size={22} /></div>
          <div className="settings-copy"><h3>已接入项目</h3><p>项目保持在原目录；Team Room 只保存路径映射和共享状态。</p></div>
          <div className="settings-state">{rooms.length} 个项目</div>
        </section>
        <section className="settings-block">
          <div className="settings-icon"><ArrowsClockwise size={22} /></div>
          <div className="settings-copy"><h3>跨浏览器同步</h3><p>项目房间、成员配置、知识库、近期群聊和对话绑定保存在你的私人站点；手机与电脑使用同一份状态。</p></div>
          <div className={classNames("settings-state", syncStatus === "已同步" && "is-good")}>{syncStatus}</div>
        </section>
        <section className="settings-block">
          <div className="settings-icon"><Code size={22} /></div>
          <div className="settings-copy"><h3>真实成员运行时</h3><p>{privateCloud ? "任务经私人配对电脑进入 Codex App Server；不会生成模拟回复。" : runtime?.available ? "已找到独立 Codex CLI，可通过 App Server 为成员绑定独立线程。" : "未连接真实 Codex 时发送功能保持关闭，不生成模拟回复。"}</p></div>
          <div className={classNames("settings-state", runtime?.connected && "is-good")}>{runtime?.connected ? "真实模式" : runtime?.available ? "可启用" : "未启用"}</div>
        </section>
        <section className="settings-block">
          <div className="settings-icon"><GithubLogo size={22} /></div>
          <div className="settings-copy"><h3>开源发布准备</h3><p>不提交密钥、会话、数据库和用户项目；依赖许可证会生成第三方声明。</p></div>
          <div className="settings-state is-good">开源检查已启用</div>
        </section>
      </div>
      <div className="settings-actions">
        {runtime?.available ? (
          <button className={runtime.connected ? "danger-button" : "primary-button"} type="button" onClick={runtime.connected ? onDisconnectRuntime : onConnectRuntime}>
            {runtime.connected ? "断开真实运行时" : "启用真实成员"}
          </button>
        ) : null}
        <button className="secondary-button" type="button" onClick={onExport}>导出本地配置</button>
        <button className="danger-button" type="button" onClick={onReset}>重置本机 Team Room 数据</button>
      </div>
    </div>
  );
}

function ImportProjectModal({ projects, loading, error, connectedPaths, onClose, onRefresh, onAttach }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header"><div><span className="eyebrow">只读发现</span><h2 id="import-title">接入现有 Codex 项目</h2></div><button className="icon-button" onClick={onClose} type="button"><X size={21} /></button></header>
        <div className="modal-note"><ShieldCheck size={19} /><span>这里只读取项目路径和对话数量，不会自动导入聊天正文。</span></div>
        <div className="project-picker">
          {loading ? <div className="center-state"><ArrowsClockwise className="spin" size={24} />正在扫描本地索引…</div> : null}
          {error ? <div className="center-state center-state--error"><WarningCircle size={24} />{error}<button className="secondary-button" onClick={onRefresh} type="button">重试</button></div> : null}
          {!loading && !error && projects.map((project) => {
            const connected = connectedPaths.has(project.path.toLowerCase());
            return (
              <button className="project-option" key={project.path} type="button" onClick={() => !connected && onAttach(project)} disabled={connected}>
                <div className="project-folder"><FolderOpen size={22} /></div>
                <div><strong>{project.name}</strong><span>{project.path}</span></div>
                <div className="project-count">{project.threadCount} 个对话</div>
                <span className={classNames("project-action", connected && "is-connected")}>{connected ? "已接入" : "接入"}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function projectDisplayName(project) {
  const name = typeof project?.name === "string" ? project.name.trim() : "";
  if (name && !/^\?+$/.test(name)) return name;
  const pathParts = String(project?.path || "").replace(/[\\/]+$/, "").split(/[\\/]/);
  const fallback = pathParts.at(-1)?.trim();
  return fallback && !/^\?+$/.test(fallback) ? fallback : "未命名项目";
}

function AgentDrawer({ agent, onClose, onSave, bindingThreads = [], isNew = false }) {
  const [form, setForm] = useState(agent);
  const [promptEdited, setPromptEdited] = useState(!isNew);
  useEffect(() => { setForm(agent); setPromptEdited(!isNew); }, [agent, isNew]);
  if (!agent) return null;

  const updateIdentity = (field, value) => {
    setForm((current) => {
      const next = { ...current, [field]: value };
      return promptEdited ? next : { ...next, systemPrompt: createSafeMemberPrompt(next) };
    });
  };

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`配置${agent.name}`} onMouseDown={(event) => event.stopPropagation()}>
        <header className="drawer-header"><div><span className="eyebrow">当前项目成员</span><h2>{isNew ? "新增成员" : agent.name}</h2></div><button className="icon-button" type="button" onClick={onClose}><X size={21} /></button></header>
        <div className="drawer-profile"><AgentAvatar agent={agent} size="xlarge" /><div><strong>{agent.role}</strong><p>{agent.description}</p></div></div>
        <label className="field-label">成员名称<input value={form.name} onChange={(event) => updateIdentity("name", event.target.value)} /></label>
        <label className="field-label">成员职责<input value={form.role} onChange={(event) => updateIdentity("role", event.target.value)} /></label>
        <label className="field-label">说明<textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
        <label className="field-label">模型<select value={form.model} onChange={(event) => setForm({ ...form, model: event.target.value })}>{MODEL_OPTIONS.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}</select></label>
        <label className="field-label">推理强度<select value={form.reasoning} onChange={(event) => setForm({ ...form, reasoning: event.target.value })}><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra High</option><option value="max">Max</option></select></label>
        <label className="field-label">项目权限<select value={form.permission} onChange={(event) => setForm({ ...form, permission: event.target.value })}><option value="read-only">只读分析（不能改文件或执行写入）</option><option value="request-write">可申请写入（每次必须由你批准）</option><option value="coordinate">协调与审批建议（不直接写入）</option></select><small>只读只限制这个成员对项目文件和命令的操作；不影响它读取当前项目共享上下文、分析附件或发言。</small></label>
        <label className="field-label">发言策略<select value={form.participation} onChange={(event) => setForm({ ...form, participation: event.target.value })}><option value="always">每条消息都路由</option><option value="relevant">职责相关时发言</option><option value="review">存在风险或需复核时发言</option><option value="knowledge">需要资料与知识时发言</option></select></label>
        <label className="field-label">绑定对话<select value={form.threadBinding === "existing" && form.boundThreadId ? form.boundThreadId : "auto"} onChange={(event) => setForm({ ...form, threadBinding: event.target.value === "auto" ? "auto" : "existing", boundThreadId: event.target.value === "auto" ? null : event.target.value })}><option value="auto">自动创建独立对话（默认）</option>{bindingThreads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}</select><small>默认会为此成员创建并持续复用独立 Codex 对话；选择历史对话只复用这一条，不会群发，但原对话历史仍会影响回答。需要全新角色时请选择自动创建。</small></label>
        <label className="field-label">成员提示词<textarea rows={7} value={form.systemPrompt || createSafeMemberPrompt(form)} onChange={(event) => { setPromptEdited(true); setForm({ ...form, systemPrompt: event.target.value }); }} /><small>提示词会作为这个成员后续 Codex turn 的开发者指令传入；它只保存于当前项目房间。</small></label>
        <div className="drawer-security"><ShieldCheck size={20} /><span>模型可以建议操作，但写入命令必须经过项目执行闸门；成员不能跨项目读取或转发上下文。</span></div>
        <div className="drawer-actions"><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="button" onClick={() => onSave({ ...form, systemPrompt: (form.systemPrompt || createSafeMemberPrompt(form)).trim() || createSafeMemberPrompt(form) })}>{isNew ? "添加成员" : "保存配置"}</button></div>
      </aside>
    </div>
  );
}

function CommandModal({ command, agent, onClose }) {
  if (!command) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal command-modal" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header"><div><span className="eyebrow">执行审批</span><h2>{command.title}</h2></div><button className="icon-button" type="button" onClick={onClose}><X size={21} /></button></header>
        <div className="command-detail-grid"><span>申请成员</span><strong>{agent?.name}</strong><span>命令</span><code>{command.command}</code><span>目标</span><strong>{command.target}</strong><span>影响</span><strong>{command.impact}</strong><span>风险</span><strong>{command.risk}</strong><span>当前状态</span><strong>{command.status}</strong></div>
        <div className="modal-note"><Info size={19} /><span>这是 Codex App Server 的真实请求；只允许本次操作，服务端写入锁会阻止并发写入。</span></div>
      </section>
    </div>
  );
}

function Toast({ message }) {
  if (!message) return null;
  return <div className="toast"><Check size={17} weight="bold" />{message}</div>;
}

export function App() {
  const [state, setState] = useState(loadState);
  const [activeView, setActiveView] = useState("chat");
  const [activeThreadId, setActiveThreadId] = useState("global");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [executionMode, setExecutionMode] = useState(true);
  const [bridge, setBridge] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [pairing, setPairing] = useState(null);
  const [syncStatus, setSyncStatus] = useState("检查中");
  const [importOpen, setImportOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState("");
  const [openAgentId, setOpenAgentId] = useState(null);
  const [newMember, setNewMember] = useState(null);
  const [inspectedCommandId, setInspectedCommandId] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [toast, setToast] = useState("");
  const autoLoadedRooms = useRef(new Set(Object.entries(state.threadCache || {})
    .filter(([, cachedThreads]) => cachedThreads?.some((thread) => thread.kind === "codex"))
    .map(([roomId]) => roomId)));
  const attachmentUrls = useRef(new Set());
  const runtimeEventCursor = useRef(0);
  const remoteEventCursor = useRef(0);
  const stateRef = useRef(state);
  const cloudRevision = useRef(0);
  const cloudHydrated = useRef(false);
  const cloudSnapshotSignature = useRef("");
  const cloudSaveTimer = useRef(null);
  const cloudWriteBusy = useRef(false);

  const activeRoom = state.rooms.find((room) => room.id === state.activeRoomId) || state.rooms[0];
  const threads = state.threadCache[activeRoom.id] || DEFAULT_THREADS;
  const agents = state.agentsByRoom?.[activeRoom.id] || [];
  const writeLock = state.writeLocksByRoom?.[activeRoom.id] || null;
  const activeThread = threads.find((thread) => thread.id === activeThreadId) || threads[0];
  const messages = state.messagesByRoom[activeRoom.id] || [];
  const commands = state.commandsByRoom[activeRoom.id] || [];
  const knowledge = state.knowledgeByRoom[activeRoom.id] || [];
  const openAgent = newMember || agents.find((agent) => agent.id === openAgentId) || null;
  const inspectedCommand = commands.find((command) => command.id === inspectedCommandId) || null;
  const connectedPaths = useMemo(() => new Set(state.rooms.map((room) => room.path.toLowerCase())), [state.rooms]);
  const realRuntimeActive = Boolean(runtime?.connected && runtime.cwd?.toLowerCase() === activeRoom.path.toLowerCase());
  const privateCloud = isPrivateCloudHost();
  const syncEndpoint = privateCloud ? "/api/state" : pairing?.configured ? "/api/sync/state" : null;
  const canSendReal = privateCloud ? Boolean(pairing?.paired) : realRuntimeActive;
  const connectionLabel = privateCloud
    ? pairing?.online ? "真实 Codex 在线" : pairing?.paired ? "真实 Codex 离线排队" : "尚未配对真实 Codex"
    : realRuntimeActive ? "真实 Codex 已连接" : "真实 Codex 未连接";

  useEffect(() => {
    stateRef.current = state;
    saveState(state);
  }, [state]);
  useEffect(() => () => {
    for (const url of attachmentUrls.current) URL.revokeObjectURL(url);
    attachmentUrls.current.clear();
  }, []);
  useEffect(() => {
    if (privateCloud) {
      setBridge({ ok: false, mode: "remote-pairing", indexedThreads: 0 });
      return;
    }
    fetch("/api/health")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("bridge unavailable")))
      .then((health) => {
        setBridge(health);
        if (health.workspacePath) {
          setState((current) => ({
            ...current,
            rooms: current.rooms.map((room) => room.source === "local" && room.path === "."
              ? { ...room, path: health.workspacePath }
              : room),
          }));
        }
      })
      .catch(() => setBridge({ ok: false, mode: "unavailable", indexedThreads: 0 }));
  }, [privateCloud]);
  useEffect(() => {
    if (privateCloud) {
      setRuntime({ available: false, reason: "由已配对电脑提供真实 Codex 运行时" });
      return;
    }
    fetch("/api/runtime/status")
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("runtime unavailable")))
      .then(setRuntime)
      .catch(() => setRuntime({ available: false, reason: "真实 Codex 运行时未连接" }));
  }, [privateCloud]);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(privateCloud ? "/api/pair/status" : "/api/pair/local-status");
        if (!response.ok) throw new Error("pairing unavailable");
        const value = await response.json();
        if (!cancelled) setPairing(privateCloud
          ? value
          : { ...value, paired: Boolean(value.configured), online: Boolean(value.running && !value.lastError) });
      } catch {
        if (!cancelled) setPairing({ paired: false, online: false, configured: false });
      }
    };
    poll();
    const interval = window.setInterval(poll, 3_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [privateCloud]);
  useEffect(() => {
    if (!syncEndpoint) {
      setSyncStatus("未启用");
      cloudHydrated.current = false;
      return undefined;
    }
    let cancelled = false;
    const pull = async ({ initial = false } = {}) => {
      try {
        const response = await fetch(syncEndpoint, { headers: { "cache-control": "no-cache" } });
        const value = await response.json();
        if (!response.ok) throw new Error(value.message || value.error || "sync_read_failed");
        if (cancelled) return;
        if (value.state && Number(value.revision) > cloudRevision.current) {
          cloudRevision.current = Number(value.revision) || 0;
          cloudSnapshotSignature.current = JSON.stringify(value.state);
          setState((current) => applyCloudSnapshot(current, value.state));
        } else if (initial && !value.state) {
          const snapshot = createCloudSnapshot(stateRef.current);
          const created = await fetch(syncEndpoint, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ state: snapshot, baseRevision: 0 }),
          });
          const createdValue = await created.json();
          if (!created.ok) throw new Error(createdValue.message || createdValue.error || "sync_create_failed");
          cloudRevision.current = Number(createdValue.revision) || 1;
          cloudSnapshotSignature.current = JSON.stringify(snapshot);
        }
        cloudHydrated.current = true;
        setSyncStatus("已同步");
      } catch {
        if (!cancelled) setSyncStatus("暂时离线");
      }
    };
    cloudRevision.current = 0;
    cloudHydrated.current = false;
    setSyncStatus("同步中");
    pull({ initial: true });
    const interval = window.setInterval(() => pull(), 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [syncEndpoint]);
  useEffect(() => {
    if (!syncEndpoint || !cloudHydrated.current) return undefined;
    const snapshot = createCloudSnapshot(state);
    const signature = JSON.stringify(snapshot);
    if (signature === cloudSnapshotSignature.current) return undefined;
    if (cloudSaveTimer.current) window.clearTimeout(cloudSaveTimer.current);
    setSyncStatus("同步中");
    cloudSaveTimer.current = window.setTimeout(async () => {
      if (cloudWriteBusy.current) return;
      cloudWriteBusy.current = true;
      try {
        const response = await fetch(syncEndpoint, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ state: snapshot, baseRevision: cloudRevision.current }),
        });
        const value = await response.json();
        if (response.status === 409) {
          const latestResponse = await fetch(syncEndpoint, { headers: { "cache-control": "no-cache" } });
          const latest = await latestResponse.json();
          if (latestResponse.ok && latest.state) {
            cloudRevision.current = Number(latest.revision) || 0;
            cloudSnapshotSignature.current = JSON.stringify(latest.state);
            setState((current) => applyCloudSnapshot(current, latest.state));
          }
          setToast("另一台设备刚更新了房间；已载入最新状态，请重试刚才的冲突操作");
          setSyncStatus("已同步");
          return;
        }
        if (!response.ok) throw new Error(value.message || value.error || "sync_write_failed");
        cloudRevision.current = Number(value.revision) || cloudRevision.current + 1;
        cloudSnapshotSignature.current = signature;
        setSyncStatus("已同步");
      } catch {
        setSyncStatus("暂时离线");
      } finally {
        cloudWriteBusy.current = false;
      }
    }, 600);
    return () => {
      if (cloudSaveTimer.current) window.clearTimeout(cloudSaveTimer.current);
    };
  }, [state, syncEndpoint]);
  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    if (!runtime?.connected) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/runtime/events?after=${runtimeEventCursor.current}`);
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled || !data.events?.length) return;
        runtimeEventCursor.current = data.events.at(-1).sequence;
        setState((current) => {
          let next = current;
          for (const event of data.events) {
            const roomId = event.roomId && next.rooms.some((room) => room.id === event.roomId) ? event.roomId : null;
            if (!roomId) continue;
            if (event.type === "agentThreadBound") {
              next = { ...next, agentsByRoom: { ...next.agentsByRoom, [roomId]: (next.agentsByRoom?.[roomId] || []).map((agent) => agent.id === event.agentId ? { ...agent, boundThreadId: event.threadId, threadBinding: event.bindingMode || agent.threadBinding || "auto" } : agent) } };
            }
            if (event.type === "agentMessage" && event.text) {
              const messageId = `runtime-message-${event.sequence}`;
              const existingMessages = next.messagesByRoom[roomId] || [];
              if (!existingMessages.some((message) => message.id === messageId)) {
                next = { ...next, messagesByRoom: { ...next.messagesByRoom, [roomId]: [...existingMessages, { id: messageId, kind: "agent", agentId: event.agentId, threadId: event.threadId || null, time: nowLabel(), text: event.text }] } };
              }
            }
            if (event.type === "approvalRequested") {
              const commandId = `runtime-command-${event.requestId}`;
              const existing = next.commandsByRoom[roomId] || [];
              if (!existing.some((command) => command.id === commandId)) {
                const command = { id: commandId, source: "runtime", runtimeRequestId: event.requestId, agentId: event.agentId, title: "Codex 请求受控执行", command: event.command, summary: "来自真实 App Server 线程，等待一次性审批。", target: event.cwd, impact: "可能写入项目", risk: "中", status: "pending", time: nowLabel() };
                next = { ...next, commandsByRoom: { ...next.commandsByRoom, [roomId]: [...existing, command] } };
              }
            }
            if (event.type === "approvalResolved") {
              next = { ...next, commandsByRoom: { ...next.commandsByRoom, [roomId]: (next.commandsByRoom[roomId] || []).map((command) => command.runtimeRequestId === event.requestId ? { ...command, status: event.decision === "accept" ? "approved" : "denied" } : command) } };
            }
            if (event.type === "writeItemCompleted") {
              next = { ...next, writeLocksByRoom: { ...next.writeLocksByRoom, [roomId]: null }, commandsByRoom: { ...next.commandsByRoom, [roomId]: (next.commandsByRoom[roomId] || []).map((command) => command.source === "runtime" && command.agentId === event.agentId && command.status === "approved" ? { ...command, status: "completed" } : command) } };
            }
          }
          return next;
        });
      } catch {
        // A temporary polling failure should not switch modes or duplicate events.
      }
    };
    poll();
    const interval = window.setInterval(poll, 800);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [runtime?.connected]);
  useEffect(() => {
    if (!privateCloud) return undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/remote/events?after=${remoteEventCursor.current}`);
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled || !data.events?.length) return;
        remoteEventCursor.current = data.events.at(-1).sequence;
        setState((current) => {
          let next = current;
          for (const event of data.events) {
            const payload = event.payload || {};
            const roomId = payload.roomId && next.rooms.some((room) => room.id === payload.roomId) ? payload.roomId : null;
            if (!roomId) continue;
            if (event.event_type === "agentThreadBound") {
              next = { ...next, agentsByRoom: { ...next.agentsByRoom, [roomId]: (next.agentsByRoom?.[roomId] || []).map((agent) => agent.id === payload.agentId ? { ...agent, boundThreadId: payload.threadId, threadBinding: payload.bindingMode || agent.threadBinding || "auto" } : agent) } };
            }
            if (event.event_type === "agentMessage" && payload.text) {
              const messageId = `remote-message-${event.sequence}`;
              const existingMessages = next.messagesByRoom[roomId] || [];
              if (!existingMessages.some((message) => message.id === messageId)) {
                next = { ...next, messagesByRoom: { ...next.messagesByRoom, [roomId]: [...existingMessages, { id: messageId, kind: "agent", agentId: payload.agentId, threadId: payload.threadId || null, time: nowLabel(), text: payload.text }] } };
              }
            }
            if (event.event_type === "approvalRequested") {
              const commandId = `remote-command-${payload.requestId}`;
              const existing = next.commandsByRoom[roomId] || [];
              if (!existing.some((command) => command.id === commandId)) {
                const command = { id: commandId, source: "remote", runtimeRequestId: payload.requestId, agentId: payload.agentId, title: "Codex 请求受控执行", command: payload.command, summary: "来自已配对电脑的真实 Codex，等待一次性审批。", target: payload.target || "已配对项目", impact: "可能写入项目", risk: "中", status: "pending", time: nowLabel() };
                next = { ...next, commandsByRoom: { ...next.commandsByRoom, [roomId]: [...existing, command] } };
              }
            }
            if (event.event_type === "approvalResolved") {
              next = { ...next, commandsByRoom: { ...next.commandsByRoom, [roomId]: (next.commandsByRoom[roomId] || []).map((command) => String(command.runtimeRequestId) === String(payload.requestId) ? { ...command, status: payload.decision === "accept" ? "approved" : "denied" } : command) } };
            }
            if (event.event_type === "writeItemCompleted") {
              next = { ...next, writeLocksByRoom: { ...next.writeLocksByRoom, [roomId]: null }, commandsByRoom: { ...next.commandsByRoom, [roomId]: (next.commandsByRoom[roomId] || []).map((command) => command.source === "remote" && command.agentId === payload.agentId && command.status === "approved" ? { ...command, status: "completed" } : command) } };
            }
          }
          return next;
        });
      } catch {
        // Keep the last visible state while the paired computer or network is temporarily unavailable.
      }
    };
    poll();
    const interval = window.setInterval(poll, 1_200);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [privateCloud]);

  const updateRoomThreads = (roomId, nextThreads) => {
    setState((current) => ({ ...current, threadCache: { ...current.threadCache, [roomId]: nextThreads } }));
  };

  const fetchThreads = async (room, { notifyOnError = false } = {}) => {
    try {
      let data;
      if (privateCloud) {
        data = await requestRemoteIndex("threads", { projectPath: room.path });
      } else {
        const response = await fetch(`/api/threads?project=${encodeURIComponent(room.path)}`);
        if (!response.ok) throw new Error("无法读取对话索引");
        data = await response.json();
      }
      const nextThreads = [
        { id: "global", title: "团队调度台", time: "现在", kind: "room" },
        ...data.threads.map((thread) => ({ ...thread, time: formatRelativeDate(thread.updatedAt), kind: "codex" })),
      ];
      updateRoomThreads(room.id, nextThreads);
      autoLoadedRooms.current.add(room.id);
      return true;
    } catch (error) {
      autoLoadedRooms.current.delete(room.id);
      setState((current) => {
        if (current.threadCache[room.id]?.length) return current;
        return { ...current, threadCache: { ...current.threadCache, [room.id]: DEFAULT_THREADS } };
      });
      if (notifyOnError) {
        const message = error instanceof Error ? error.message : "读取失败";
        setToast(/599|timeout|超时/.test(message)
          ? "与已配对电脑的连接刚刚中断，正在自动重试"
          : `读取对话失败：${message}`);
      }
      return false;
    }
  };

  useEffect(() => {
    const localIndexReady = bridge?.ok || (privateCloud && pairing?.online);
    if (!localIndexReady || !activeRoom || autoLoadedRooms.current.has(activeRoom.id)) return;
    let cancelled = false;
    let retryTimer = null;
    const load = async () => {
      const loaded = await fetchThreads(activeRoom);
      if (!cancelled && !loaded) retryTimer = window.setTimeout(load, 3_000);
    };
    load();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [bridge?.ok, privateCloud, pairing?.online, activeRoom?.id]);

  const selectRoom = (roomId) => {
    const room = state.rooms.find((item) => item.id === roomId);
    setState((current) => ({ ...current, activeRoomId: roomId }));
    setActiveView("chat");
    setActiveThreadId("global");
    setHistory(null);
    setOpenAgentId(null);
    setNewMember(null);
    clearSelectedAttachments();
    if (room) fetchThreads(room, { notifyOnError: true });
  };

  const openAgentEditor = (agentId) => {
    setNewMember(null);
    setOpenAgentId(agentId);
    const localIndexReady = bridge?.ok || (privateCloud && pairing?.online);
    if (localIndexReady) fetchThreads(activeRoom, { notifyOnError: true });
  };

  const selectThread = async (thread, { force = false } = {}) => {
    setActiveView("chat");
    setActiveThreadId(thread.id);
    setHistory(null);
    setHistoryError("");
    if (thread.id === "global") return;
    const cachedHistory = stateRef.current.historyCacheByThread?.[thread.id];
    if (cachedHistory && !force) {
      setHistory({ thread: cachedHistory.thread, messages: cachedHistory.messages });
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    try {
      let nextHistory;
      if (privateCloud) {
        nextHistory = await requestRemoteIndex("messages", { threadId: thread.id, force });
      } else {
        const response = await fetch(`/api/threads/${encodeURIComponent(thread.id)}/messages`);
        if (!response.ok) throw new Error("无法读取这个历史对话");
        nextHistory = await response.json();
      }
      setHistory(nextHistory);
      setState((current) => ({
        ...current,
        historyCacheByThread: {
          ...(current.historyCacheByThread || {}),
          [thread.id]: { ...nextHistory, roomId: activeRoom.id, cachedAt: new Date().toISOString() },
        },
      }));
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "读取失败");
    } finally {
      setHistoryLoading(false);
    }
  };

  const loadProjects = async () => {
    setProjectsLoading(true);
    setProjectsError("");
    try {
      let data;
      if (privateCloud) {
        if (!pairing?.online) throw new Error("配对电脑当前离线");
        data = await requestRemoteIndex("projects");
      } else {
        const response = await fetch("/api/projects");
        if (!response.ok) throw new Error("本地索引暂不可用");
        data = await response.json();
      }
      const nextProjects = (data.projects || []).map((project) => ({ ...project, name: projectDisplayName(project) }));
      setProjects(nextProjects);
      const namesByPath = new Map(nextProjects.map((project) => [project.path.toLowerCase(), project.name]));
      setState((current) => ({
        ...current,
        rooms: current.rooms.map((room) => namesByPath.has(room.path.toLowerCase()) ? { ...room, name: namesByPath.get(room.path.toLowerCase()) } : room),
      }));
    } catch (error) {
      setProjectsError(error instanceof Error ? error.message : "扫描失败");
    } finally {
      setProjectsLoading(false);
    }
  };

  const openImport = () => {
    setImportOpen(true);
    loadProjects();
  };

  const attachProject = (project) => {
    const roomId = `room-${Date.now()}`;
    const room = { id: roomId, name: projectDisplayName(project), path: project.path, source: "codex-index", connected: true };
    setState((current) => ({
      ...current,
      rooms: [...current.rooms, room],
      activeRoomId: roomId,
      messagesByRoom: { ...current.messagesByRoom, [roomId]: [{ id: `welcome-${roomId}`, kind: "system", time: nowLabel(), text: `已安全接入 ${project.name}，发现 ${project.threadCount} 个历史对话；查看历史不会修改原对话` }] },
      commandsByRoom: { ...current.commandsByRoom, [roomId]: [] },
      knowledgeByRoom: { ...current.knowledgeByRoom, [roomId]: [] },
      threadCache: { ...current.threadCache, [roomId]: [{ id: "global", title: "团队调度台", time: "现在", kind: "room" }] },
      agentsByRoom: { ...current.agentsByRoom, [roomId]: createRoomAgents() },
      writeLocksByRoom: { ...current.writeLocksByRoom, [roomId]: null },
    }));
    setActiveView("chat");
    setActiveThreadId("global");
    setImportOpen(false);
    fetchThreads(room);
    setToast(`已接入 ${room.name}`);
  };

  const removeRoom = (room) => {
    const confirmed = window.confirm(`只从 Team Room 移除“${room.name}”？\n\n电脑里的项目文件和 Codex 历史对话都不会被删除。`);
    if (!confirmed) return;
    setState((current) => {
      const remainingRooms = current.rooms.filter((item) => item.id !== room.id);
      const nextRoomId = current.activeRoomId === room.id ? remainingRooms[0]?.id : current.activeRoomId;
      const messagesByRoom = { ...current.messagesByRoom };
      const commandsByRoom = { ...current.commandsByRoom };
      const knowledgeByRoom = { ...current.knowledgeByRoom };
      const threadCache = { ...current.threadCache };
      const historyCacheByThread = Object.fromEntries(Object.entries(current.historyCacheByThread || {})
        .filter(([, cached]) => cached.roomId !== room.id));
      const agentsByRoom = { ...current.agentsByRoom };
      const writeLocksByRoom = { ...current.writeLocksByRoom };
      delete messagesByRoom[room.id];
      delete commandsByRoom[room.id];
      delete knowledgeByRoom[room.id];
      delete threadCache[room.id];
      delete agentsByRoom[room.id];
      delete writeLocksByRoom[room.id];
      return { ...current, rooms: remainingRooms, activeRoomId: nextRoomId, messagesByRoom, commandsByRoom, knowledgeByRoom, threadCache, historyCacheByThread, agentsByRoom, writeLocksByRoom };
    });
    setActiveView("chat");
    setActiveThreadId("global");
    setHistory(null);
    setOpenAgentId(null);
    setNewMember(null);
    setToast(`已从 Team Room 移除 ${room.name}`);
  };

  const connectRuntime = async () => {
    if (!agents.length) {
      setToast("请先为当前项目新增至少一位成员");
      return;
    }
    if (!runtime?.available) {
      setToast("未找到可独立启动的 Codex CLI");
      return;
    }
    const confirmed = window.confirm(`为“${activeRoom.name}”启动真实 Codex 成员？每位发言成员会使用自己的模型和独立线程；任何写入仍需你逐次批准。`);
    if (!confirmed) return;
    try {
      runtimeEventCursor.current = 0;
      const status = await postJson("/api/runtime/connect", { confirmed: true, cwd: activeRoom.path, roomId: activeRoom.id, agents });
      setRuntime(status);
      setToast("真实成员运行时已连接");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "连接失败");
    }
  };

  const disconnectRuntime = async () => {
    try {
      const status = await postJson("/api/runtime/disconnect", {});
      setRuntime(status);
      setState((current) => ({ ...current, writeLocksByRoom: { ...current.writeLocksByRoom, [activeRoom.id]: null } }));
      setToast("已断开真实运行时；发送功能已关闭");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "断开失败");
    }
  };

  const addSelectedFiles = (fileList) => {
    const { accepted, errors } = validateSelectedFiles(fileList, attachments.length);
    if (errors.length) setToast(errors[0]);
    if (!accepted.length) return;
    setAttachments((current) => [...current, ...accepted.map((file) => {
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      if (previewUrl) attachmentUrls.current.add(previewUrl);
      return { clientId: `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: file.name, type: file.type || "application/octet-stream", size: file.size, file, previewUrl };
    })]);
  };

  const removeSelectedAttachment = (clientId) => {
    setAttachments((current) => {
      const removed = current.find((item) => item.clientId === clientId);
      if (removed?.previewUrl) {
        URL.revokeObjectURL(removed.previewUrl);
        attachmentUrls.current.delete(removed.previewUrl);
      }
      return current.filter((item) => item.clientId !== clientId);
    });
  };

  const clearSelectedAttachments = () => {
    for (const attachment of attachments) {
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
        attachmentUrls.current.delete(attachment.previewUrl);
      }
    }
    setAttachments([]);
  };

  const uploadAttachment = async (attachment) => {
    const response = await fetch("/api/attachments", {
      method: "POST",
      headers: { "content-type": attachment.type, "x-file-name": encodeURIComponent(attachment.name) },
      body: attachment.file,
    });
    const value = await response.json();
    if (!response.ok || !value.attachment?.id) throw new Error(value.error || `附件上传失败：${attachment.name}`);
    return value.attachment;
  };

  const sendMessage = async () => {
    const visibleText = draft.trim();
    if ((!visibleText && !attachments.length) || sending) return;
    if (!agents.length) {
      setToast("当前项目没有成员；请先在成员配置中新增成员");
      return;
    }
    if (!canSendReal) {
      setToast(privateCloud ? "请先完成私人电脑配对" : "请先在设置中启用真实 Codex 成员");
      return;
    }

    setSending(true);
    let uploaded = [];
    try {
      uploaded = await Promise.all(attachments.map(uploadAttachment));
      const text = visibleText || `请查看并处理附件：${uploaded.map((item) => item.name).join("、")}`;
      const decisions = decideParticipation(text, agents);
      const dispatchAgents = executionMode ? agents : agents.map((agent) => agent.permission === "request-write" ? { ...agent, permission: "read-only" } : agent);
      const messageId = `user-${Date.now()}`;
      const contextId = globalThis.crypto?.randomUUID ? `context-${globalThis.crypto.randomUUID()}` : `context-${Date.now()}`;
      const sharedContext = buildRoomSharedContext({ room: activeRoom, messages, knowledge, agents, contextId });
      const silentNames = decisions.filter((item) => item.decision === "silent").map((item) => agents.find((agent) => agent.id === item.agentId)?.name).filter(Boolean);
      let dispatchLabel;

      if (privateCloud) {
        await postJson("/api/remote/tasks", { text, decisions, agents: dispatchAgents, attachments: uploaded, sharedContext, roomId: activeRoom.id, messageId, cwd: activeRoom.path });
        dispatchLabel = pairing.online ? "已发送到配对电脑的真实 Codex" : "真实任务已排队，电脑上线后执行";
      } else {
        const result = await postJson("/api/runtime/dispatch", { text, decisions, attachments: uploaded, sharedContext, executionMode, messageId, roomId: activeRoom.id });
        dispatchLabel = `已分派到 ${result.turns.length} 个真实 Codex 成员对话 · 上下文 ${contextId.slice(-8)}`;
      }

      const userMessage = { id: messageId, kind: "user", time: nowLabel(), text: visibleText, attachments: uploaded.map(({ id, name, type, size }) => ({ id, name, type, size })) };
      setState((current) => ({
        ...current,
        agentsByRoom: { ...current.agentsByRoom, [activeRoom.id]: (current.agentsByRoom?.[activeRoom.id] || []).map((agent) => ({ ...agent, status: decisions.find((item) => item.agentId === agent.id)?.decision === "speak" ? "thinking" : "silent", statusLabel: decisions.find((item) => item.agentId === agent.id)?.decision === "speak" ? "真实处理中" : "本轮静默" })) },
        messagesByRoom: { ...current.messagesByRoom, [activeRoom.id]: [
          ...(current.messagesByRoom[activeRoom.id] || []),
          userMessage,
          ...(silentNames.length ? [{ id: `silent-${Date.now()}`, kind: "system", time: nowLabel(), text: `${silentNames.join("、")}按当前项目发言策略保持静默` }] : []),
          { id: `dispatch-${Date.now()}`, kind: "system", time: nowLabel(), text: dispatchLabel },
        ] },
      }));
      setDraft("");
      clearSelectedAttachments();
    } catch (error) {
      await Promise.all(uploaded.map((attachment) => fetch(`/api/attachments/${encodeURIComponent(attachment.id)}`, { method: "DELETE" }).catch(() => null)));
      setToast(error instanceof Error ? error.message : "真实任务发送失败");
    } finally {
      setSending(false);
    }
  };

  const updateCommand = (commandId, status) => {
    setState((current) => ({
      ...current,
      commandsByRoom: {
        ...current.commandsByRoom,
        [activeRoom.id]: (current.commandsByRoom[activeRoom.id] || []).map((command) => command.id === commandId ? { ...command, status } : command),
      },
    }));
  };

  const approveCommand = async (command) => {
    if (writeLock && writeLock.agentId !== command.agentId) {
      setToast("已有成员持有写入锁，请先完成当前操作");
      return;
    }
    if (command.source === "runtime" || command.source === "remote") {
      try {
        await postJson(command.source === "remote" ? "/api/remote/approvals" : "/api/runtime/approval", { requestId: command.runtimeRequestId, decision: "accept" });
      } catch (error) {
        setToast(error instanceof Error ? error.message : "审批失败");
        return;
      }
    }
    setState((current) => ({
      ...current,
      writeLocksByRoom: { ...current.writeLocksByRoom, [activeRoom.id]: { agentId: command.agentId, commandId: command.id, acquiredAt: new Date().toISOString() } },
      commandsByRoom: { ...current.commandsByRoom, [activeRoom.id]: (current.commandsByRoom[activeRoom.id] || []).map((item) => item.id === command.id ? { ...item, status: "approved" } : item) },
      messagesByRoom: { ...current.messagesByRoom, [activeRoom.id]: [...(current.messagesByRoom[activeRoom.id] || []), { id: `approved-${Date.now()}`, kind: "system", time: nowLabel(), text: "已授予开发一次性写入权限，并锁定项目写入权" }] },
    }));
    setToast("已批准一次并加锁");
  };

  const denyCommand = async (command) => {
    if (command.source === "runtime" || command.source === "remote") {
      try {
        await postJson(command.source === "remote" ? "/api/remote/approvals" : "/api/runtime/approval", { requestId: command.runtimeRequestId, decision: "decline" });
      } catch (error) {
        setToast(error instanceof Error ? error.message : "拒绝失败");
        return;
      }
    }
    updateCommand(command.id, "denied");
    setToast("执行请求已拒绝");
  };

  const saveAgent = (nextAgent) => {
    if (realRuntimeActive) {
      setToast("请先断开真实成员运行时，再修改当前项目成员配置");
      return;
    }
    const previousAgent = agents.find((agent) => agent.id === nextAgent.id) || null;
    const normalized = {
      ...nextAgent,
      name: nextAgent.name.trim() || "未命名成员",
      role: nextAgent.role.trim() || "项目协作者",
      systemPrompt: String(nextAgent.systemPrompt || createSafeMemberPrompt(nextAgent)).trim().slice(0, 12_000) || createSafeMemberPrompt(nextAgent),
    };
    const promptChanged = previousAgent && previousAgent.systemPrompt !== normalized.systemPrompt;
    if (promptChanged && normalized.threadBinding === "auto") normalized.boundThreadId = null;
    if (normalized.threadBinding === "existing" && !threads.some((thread) => thread.kind === "codex" && thread.id === normalized.boundThreadId)) {
      setToast("只能绑定当前项目列表中的已有对话；请刷新后重新选择");
      return;
    }
    setState((current) => ({
      ...current,
      agentsByRoom: {
        ...current.agentsByRoom,
        [activeRoom.id]: newMember?.id === normalized.id
          ? addRoomMember(current.agentsByRoom?.[activeRoom.id], normalized)
          : replaceRoomMember(current.agentsByRoom?.[activeRoom.id], normalized),
      },
    }));
    setOpenAgentId(null);
    setNewMember(null);
    setToast(newMember?.id === normalized.id
      ? `${normalized.name}已加入当前项目`
      : promptChanged && normalized.threadBinding === "auto"
        ? `${normalized.name}提示词已保存；下次将创建新的独立对话以确保生效`
        : `${normalized.name}配置已保存`);
  };

  const addMember = () => {
    if (realRuntimeActive) {
      setToast("请先断开真实成员运行时，再新增当前项目成员");
      return;
    }
    setOpenAgentId(null);
    setNewMember(createProjectMember());
    const localIndexReady = bridge?.ok || (privateCloud && pairing?.online);
    if (localIndexReady) fetchThreads(activeRoom, { notifyOnError: true });
  };

  const removeAgent = (agent) => {
    if (realRuntimeActive) {
      setToast("请先断开真实成员运行时，再移除当前项目成员");
      return;
    }
    const confirmed = window.confirm(`只从“${activeRoom.name}”移除成员“${agent.name}”？\n\n不会删除任何 Codex 对话、项目文件或其他项目的成员配置。`);
    if (!confirmed) return;
    setState((current) => ({
      ...current,
      agentsByRoom: { ...current.agentsByRoom, [activeRoom.id]: removeRoomMember(current.agentsByRoom?.[activeRoom.id], agent.id) },
      writeLocksByRoom: current.writeLocksByRoom?.[activeRoom.id]?.agentId === agent.id
        ? { ...current.writeLocksByRoom, [activeRoom.id]: null }
        : current.writeLocksByRoom,
    }));
    if (openAgentId === agent.id) setOpenAgentId(null);
    setToast(`${agent.name}已从当前项目移除`);
  };

  const addKnowledge = (form) => {
    const entry = { id: `knowledge-${Date.now()}`, ...form, updatedAt: `今天 ${nowLabel()}` };
    setState((current) => ({ ...current, knowledgeByRoom: { ...current.knowledgeByRoom, [activeRoom.id]: [entry, ...(current.knowledgeByRoom[activeRoom.id] || [])] } }));
    setToast("知识条目已保存");
  };

  const attachHistory = () => {
    if (!history) return;
    const visibleTranscript = history.messages.slice(-120).map((message) => `${message.role === "user" ? "用户" : "Codex"}：${String(message.text || "").slice(0, 4_000)}`).join("\n\n").slice(0, 40_000);
    const entry = {
      id: `knowledge-history-${Date.now()}`,
      title: history.thread.title,
      category: "历史对话",
      body: `来源对话：${history.thread.title}\n已复制 ${Math.min(history.messages.length, 120)} 条可见消息到当前项目共享上下文；原始对话保持不变。\n\n${visibleTranscript}`,
      updatedAt: `今天 ${nowLabel()}`,
    };
    setState((current) => ({
      ...current,
      knowledgeByRoom: { ...current.knowledgeByRoom, [activeRoom.id]: [entry, ...(current.knowledgeByRoom[activeRoom.id] || [])] },
      messagesByRoom: { ...current.messagesByRoom, [activeRoom.id]: [...(current.messagesByRoom[activeRoom.id] || []), { id: `history-${Date.now()}`, kind: "system", time: nowLabel(), text: `已将历史对话“${history.thread.title}”挂入公共上下文` }] },
    }));
    setActiveThreadId("global");
    setHistory(null);
    setToast("历史对话已挂入公共上下文");
  };

  const exportConfig = () => {
    const sanitized = { ...state, messagesByRoom: {}, commandsByRoom: {} };
    const blob = new Blob([JSON.stringify(sanitized, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "codex-team-room-config.json";
    anchor.click();
    URL.revokeObjectURL(url);
    setToast("已导出不含聊天记录的配置");
  };

  const resetPrototype = () => {
    if (!window.confirm(syncEndpoint
      ? "重置已同步的 Team Room 配置与房间状态？这个变化会同步到你的其他浏览器，但不会删除任何 Codex 对话或项目文件。"
      : "重置这台设备上的 Team Room 配置与房间状态？这个操作不会删除任何 Codex 对话或项目文件。")) return;
    const next = resetState();
    setState(next);
    setActiveView("chat");
    setActiveThreadId("global");
    setToast("本机 Team Room 数据已重置");
  };

  const renderCenter = () => {
    if (activeView === "knowledge") return <KnowledgeView entries={knowledge} onAdd={addKnowledge} />;
    if (activeView === "agents") return <AgentSettingsView agents={agents} onOpenAgent={openAgentEditor} onAddMember={addMember} onRemoveAgent={removeAgent} />;
    if (activeView === "settings") return <SettingsView bridge={bridge} pairing={pairing} runtime={runtime} rooms={state.rooms} syncStatus={syncStatus} onConnectRuntime={connectRuntime} onDisconnectRuntime={disconnectRuntime} onExport={exportConfig} onReset={resetPrototype} />;
    if (activeThreadId !== "global") return <HistoryView history={history} loading={historyLoading} error={historyError} onAttach={attachHistory} onRefresh={() => selectThread(activeThread, { force: true })} />;
    return (
      <ChatView
        messages={messages}
        commands={commands}
        agents={agents}
        writeLock={writeLock}
        draft={draft}
        executionMode={executionMode}
        onDraftChange={setDraft}
        onSend={sendMessage}
        onToggleMode={() => setExecutionMode((value) => !value)}
        onInspect={(command) => setInspectedCommandId(command.id)}
        onApprove={approveCommand}
        onDeny={denyCommand}
        attachments={attachments}
        onFilesSelected={addSelectedFiles}
        onRemoveAttachment={removeSelectedAttachment}
        sending={sending}
        canSend={canSendReal}
        connectionLabel={connectionLabel}
      />
    );
  };

  return (
    <div className={classNames("app-shell", !(activeView === "chat" && activeThreadId === "global") && "app-shell--wide")}>
      <Sidebar
        rooms={state.rooms}
        activeRoom={activeRoom}
        threads={threads}
        activeThreadId={activeThreadId}
        activeView={activeView}
        bridge={bridge}
        pairing={pairing}
        onSelectRoom={selectRoom}
        onSelectThread={selectThread}
        onOpenImport={openImport}
        onRemoveRoom={removeRoom}
        onSelectView={(view) => { setActiveView(view); setHistory(null); }}
      />
      <main className="main-panel">
        <RoomHeader room={activeRoom} rooms={state.rooms} activeView={activeView} activeThread={activeThread} onSelectRoom={selectRoom} />
        <div className="main-content">{renderCenter()}</div>
      </main>
      {activeView === "chat" && activeThreadId === "global" ? <AgentRoster agents={agents} onOpenAgent={openAgentEditor} /> : null}

      {importOpen ? <ImportProjectModal projects={projects} loading={projectsLoading} error={projectsError} connectedPaths={connectedPaths} onClose={() => setImportOpen(false)} onRefresh={loadProjects} onAttach={attachProject} /> : null}
      {openAgent ? <AgentDrawer agent={openAgent} bindingThreads={threads.filter((thread) => thread.kind === "codex")} isNew={Boolean(newMember)} onClose={() => { setOpenAgentId(null); setNewMember(null); }} onSave={saveAgent} /> : null}
      {inspectedCommand ? <CommandModal command={inspectedCommand} agent={agents.find((agent) => agent.id === inspectedCommand.agentId)} onClose={() => setInspectedCommandId(null)} /> : null}
      <Toast message={toast} />
    </div>
  );
}
