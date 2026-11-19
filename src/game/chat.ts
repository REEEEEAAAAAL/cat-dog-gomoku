import './chat.css';
import { sendChat } from './api';
import { chatLength, validChatText } from './chat-protocol';
import type { ChatSnapshot } from './chat-protocol';
import type { Command, Reply, Snapshot } from './protocol';
import { errorMessage, RpcError } from './protocol';
import { createId } from './rules';

interface Outgoing { id: string; text: string; bonus?: { gameId: string; version: number }; undoFull?: true }
const bonusNotice = '皇帝驾到！本局悔棋机会 +1 👑';
const undoFullNotice = '你已经有2次悔棋机会啦！先用掉它们~';

/** 普通消息独立收发；悔棋口令先由游戏命令核对额度，满额时作为普通消息发送。 */
export class RoomChat {
  private readonly toggle = document.getElementById('chatToggle') as HTMLButtonElement;
  private readonly panel = document.getElementById('chatPanel')!;
  private readonly list = document.getElementById('chatMessages')!;
  private readonly input = document.getElementById('chatInput') as HTMLTextAreaElement;
  private readonly send = document.getElementById('chatSend') as HTMLButtonElement;
  private readonly status = document.getElementById('chatStatus')!;
  private readonly latest = document.getElementById('chatLatest') as HTMLButtonElement;
  private state: Snapshot | null = null;
  private data: ChatSnapshot | null = null;
  private outgoing: Outgoing | null = null;
  private available = false;
  private sending = false;
  private reading = false;
  private composing = false;
  private compositionEnded = 0;
  // 房间或席位切换时递增，防止旧异步请求清空新会话的草稿和发送状态。
  private generation = 0;
  private readSeq = 0;
  private lastSync = 0;
  private activeAt = 0;
  private failedReads = 0;
  private inputFocusScrollY: number | null = null;

  constructor(private readonly client: string, private readonly exchange: (request: Command) => Promise<Reply | null>,
    private readonly onUndoCredit: () => void) {
    this.toggle.onclick = () => this.open(!!this.panel.hidden);
    document.getElementById('negotiationChatToggle')!.onclick = () => this.open(true);
    document.getElementById('chatClose')!.onclick = () => this.open(false);
    this.latest.onclick = () => { this.list.scrollTop = this.list.scrollHeight; this.markRead(); };
    this.list.addEventListener('scroll', () => {
      if (this.atBottom()) this.markRead();
      else this.renderLatestButton();
    }, { passive: true });
    for (const event of ['pointerdown', 'keydown'] as const) this.panel.addEventListener(event, () => { this.activeAt = Date.now(); });
    this.input.addEventListener('input', () => this.renderControls());
    this.input.addEventListener('pointerdown', () => { this.inputFocusScrollY ??= window.scrollY; });
    this.input.addEventListener('focus', () => { this.inputFocusScrollY ??= window.scrollY; });
    // 输入法确认候选字可能紧接 Enter 或 submit，组合结束后的短窗口仍禁止发送。
    this.input.addEventListener('compositionstart', () => { this.composing = true; this.renderControls(); });
    this.input.addEventListener('compositionend', () => {
      this.composing = false; this.compositionEnded = Date.now(); this.renderControls();
      window.setTimeout(() => this.renderControls(), 250);
    });
    this.input.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.shiftKey) return;
      if (event.isComposing || this.composing || event.keyCode === 229 || Date.now() - this.compositionEnded < 250) return;
      event.preventDefault(); void this.submit();
    });
    this.panel.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !event.isComposing && !this.composing) { event.stopPropagation(); this.open(false); }
    });
    document.getElementById('chatForm')!.addEventListener('submit', event => {
      event.preventDefault();
      if (!this.composing && Date.now() - this.compositionEnded >= 250) void this.submit();
    });
    // 使用可视视口尺寸和偏移避开软键盘，兼容键盘出现后页面整体上移的情况。
    const viewport = () => {
      const v = window.visualViewport;
      this.panel.style.setProperty('--chat-height', `${v?.height ?? innerHeight}px`);
      this.panel.style.setProperty('--chat-bottom', `${Math.max(0, innerHeight - (v?.height ?? innerHeight) - (v?.offsetTop ?? 0))}px`);
    };
    window.visualViewport?.addEventListener('resize', viewport);
    window.visualViewport?.addEventListener('scroll', viewport);
    window.addEventListener('resize', viewport); viewport();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { this.activeAt = Date.now(); this.markRead(); }
    });
    window.addEventListener('focus', () => this.markRead());
    window.addEventListener('scroll', () => this.markRead(), { passive: true });
    new ResizeObserver(() => { this.markRead(); this.renderLatestButton(); }).observe(this.list);
    new IntersectionObserver(() => this.markRead()).observe(this.list);
    window.setInterval(() => { void this.poll(); }, 1000);
  }

  /** 以游戏快照刷新聊天；null 清空会话，available 表示当前连接允许收发。 */
  update(state: Snapshot | null, available: boolean) {
    if (state && state !== this.state) this.lastSync = Date.now();
    if (state?.room !== this.state?.room || state?.seat !== this.state?.seat) {
      this.generation++; this.open(false, false); this.data = null; this.outgoing = null;
      this.sending = false; this.reading = false; this.failedReads = 0; this.readSeq = 0;
      this.input.value = ''; this.list.replaceChildren(); this.status.textContent = '';
      this.state = state;
      if (state) this.restore();
    }
    this.state = state; this.available = available;
    this.toggle.hidden = !state;
    if (state?.chat) this.receive(state.chat);
    this.renderControls();
  }

  // 待确认消息和已读位置按房间、席位隔离，只在当前标签页会话内保存。
  private key(suffix: string) { return `gomoku.chat.${this.state?.room}.${this.state?.seat}.${suffix}`; }

  private save() {
    if (!this.state) return;
    try {
      if (this.outgoing) sessionStorage.setItem(this.key('outgoing'), JSON.stringify(this.outgoing));
      else sessionStorage.removeItem(this.key('outgoing'));
      sessionStorage.setItem(this.key('read'), String(this.readSeq));
    } catch { this.status.textContent = '浏览器无法保存待发送记录，请保持本页打开并核对消息。'; }
  }

  private restore() {
    try {
      this.readSeq = Math.max(0, Number(sessionStorage.getItem(this.key('read'))) || 0);
      const saved: unknown = JSON.parse(sessionStorage.getItem(this.key('outgoing')) || 'null');
      if (saved && typeof saved === 'object' && 'id' in saved && typeof saved.id === 'string'
        && 'text' in saved && typeof saved.text === 'string' && validChatText(saved.text)) {
        const outgoing: Outgoing = { id: saved.id, text: saved.text };
        if ('bonus' in saved) {
          const bonus = saved.bonus;
          if (!bonus || typeof bonus !== 'object' || !('gameId' in bonus) || typeof bonus.gameId !== 'string'
            || !('version' in bonus) || typeof bonus.version !== 'number' || !Number.isSafeInteger(bonus.version)
            || saved.text !== 'iamking') throw new Error('Invalid saved bonus');
          outgoing.bonus = { gameId: bonus.gameId, version: bonus.version };
        }
        if ('undoFull' in saved) {
          if (saved.undoFull !== true || saved.text !== 'iamking' || outgoing.bonus) throw new Error('Invalid saved full undo message');
          outgoing.undoFull = true;
        }
        this.outgoing = outgoing;
        this.input.value = saved.text;
        this.status.textContent = '上次发送尚未确认，请重试核对。';
      }
    } catch { this.status.textContent = '无法恢复上次待发送记录，请先核对消息。'; }
  }

  private atBottom() { return this.list.scrollHeight - this.list.clientHeight - this.list.scrollTop <= 32; }

  private open(open: boolean, focus = true) {
    this.panel.hidden = !open; this.toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      this.inputFocusScrollY = window.scrollY;
      this.activeAt = Date.now(); this.list.scrollTop = this.list.scrollHeight; this.markRead();
      if (focus) document.getElementById('chatClose')!.focus({ preventScroll: true });
      void this.poll();
    } else if (focus) {
      const negotiation = document.getElementById('negotiationDialog') as HTMLDialogElement;
      (negotiation.open ? document.getElementById('negotiationChatToggle')! : this.toggle).focus({ preventScroll: true });
    }
    if (!open && this.inputFocusScrollY !== null) {
      const scrollY = this.inputFocusScrollY;
      this.inputFocusScrollY = null;
      this.input.blur();
      const restore = () => window.scrollTo(0, scrollY);
      requestAnimationFrame(restore);
      window.setTimeout(restore, 300);
    }
  }

  // 只有最新消息确实处于可视区域才标记已读，软键盘遮挡或后台页面不消耗未读。
  private markRead() {
    if (this.panel.hidden || document.hidden || !this.atBottom()) return;
    const last = this.list.lastElementChild?.getBoundingClientRect();
    const list = this.list.getBoundingClientRect();
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const bottom = top + (viewport?.height ?? innerHeight);
    if (!last || list.width <= 0 || last.bottom > Math.min(list.bottom, bottom) + 1
      || last.bottom <= Math.max(list.top, top) || list.right <= 0 || list.left >= innerWidth) return;
    this.readSeq = this.data?.revision ?? 0; this.save(); this.renderUnread();
  }

  private renderUnread() {
    const count = this.data?.messages.filter(m => m.seat !== this.state?.seat && m.seq > this.readSeq).length ?? 0;
    this.toggle.textContent = count ? `聊天 · ${count}` : '聊天';
    this.toggle.classList.toggle('has-unread', count > 0);
    this.toggle.setAttribute('aria-label', count ? `聊天，${count} 条未读` : '聊天');
    this.latest.hidden = !count || this.panel.hidden;
    this.latest.textContent = '↓';
    this.latest.setAttribute('aria-label', count ? `跳到最新消息，有 ${count} 条未读` : '跳到最新消息');
    this.renderLatestButton();
  }

  private renderLatestButton() {
    this.latest.hidden = this.panel.hidden || this.atBottom();
  }

  // 聊天 revision 独立去重；同版本回包也可能携带待发送消息的确认。
  private receive(data: ChatSnapshot) {
    if (data.room !== this.state?.room || data.revision < (this.data?.revision ?? -1)) return;
    const changed = data.revision !== this.data?.revision;
    const bottom = this.atBottom();
    // 阅读历史时记录首个可见消息及偏移，重建最近 50 条窗口后尽量保持阅读位置。
    const anchor = Array.from(this.list.children).find(node => node.getBoundingClientRect().bottom > this.list.getBoundingClientRect().top);
    const offset = anchor ? anchor.getBoundingClientRect().top - this.list.getBoundingClientRect().top : 0;
    const anchorSeq = (anchor as HTMLElement | undefined)?.dataset.seq;
    const confirmed = this.outgoing && (data.ack === this.outgoing.id || data.messages.some(m => m.id === this.outgoing?.id && m.seat === this.state?.seat));
    const followLatest = bottom || !!confirmed;
    this.data = data;
    if (confirmed) {
      this.status.textContent = this.outgoing?.undoFull ? undoFullNotice : '';
      this.outgoing = null; this.input.value = ''; this.save();
    }
    if (changed) {
      this.list.replaceChildren();
      if (!data.messages.length) {
        const empty = document.createElement('li'); empty.className = 'chat-empty'; empty.textContent = '和对方打个招呼吧~ 消息仅对已入座的你们可见哦！'; this.list.appendChild(empty);
      }
      for (const message of data.messages) {
        const item = document.createElement('li'); item.dataset.seq = String(message.seq);
        item.className = message.seat === this.state?.seat ? 'chat-message own' : 'chat-message';
        const label = document.createElement('small');
        label.textContent = `${this.state?.players[message.seat - 1].name || '玩家'}${message.seat === this.state?.seat ? '（你）' : ''}`;
        // 用户输入始终按纯文本渲染，消息中的标签和脚本不会作为 HTML 解释。
        const body = document.createElement('p'); body.textContent = message.text;
        const bubble = document.createElement('div'); bubble.className = 'chat-bubble-group';
        if (message.seat === this.state?.seat) {
          const sent = document.createElement('small'); sent.className = 'chat-sent'; sent.textContent = '已发送'; bubble.appendChild(sent);
        }
        bubble.appendChild(body);
        item.appendChild(label); item.appendChild(bubble); this.list.appendChild(item);
      }
      if (!followLatest && anchorSeq) {
        const restored = this.list.querySelector<HTMLElement>(`[data-seq="${anchorSeq}"]`);
        if (restored) this.list.scrollTop += restored.getBoundingClientRect().top - this.list.getBoundingClientRect().top - offset;
      }
    }
    if (followLatest) this.list.scrollTop = this.list.scrollHeight;
    this.renderUnread();
    this.markRead();
    this.renderControls();
  }

  private renderControls() {
    const closed = this.state?.phase === 'closed';
    this.input.readOnly = !!this.outgoing || closed;
    this.send.disabled = !this.available || closed || !this.state?.chat || this.sending || this.composing
      || Date.now() - this.compositionEnded < 250 || !validChatText(this.input.value);
    this.send.textContent = this.sending ? '发送中…' : this.outgoing ? '重试发送' : '发送';
    document.getElementById('chatCount')!.textContent = `${chatLength(this.input.value)}/100 字`;
    const availability = document.getElementById('chatAvailability')!;
    const status = this.status.textContent;
    availability.classList.toggle('chat-error', !!status && status !== bonusNotice && status !== undoFullNotice);
    availability.textContent = status || (closed ? '房间已关闭，无法继续发送。'
      : !this.state?.chat ? '聊天暂不可用，请等待服务更新。'
      : !this.available ? '连接恢复后可发送，输入会保留。' : '仅保留最近 50 条 · Enter 发送，Shift+Enter 换行');
  }

  private async submit() {
    if (this.send.disabled || this.composing || !this.state) return;
    const generation = this.generation;
    // 首次发送即固定 ID 和正文；回执丢失或刷新后重试必须沿用同一组数据。
    this.outgoing ??= { id: createId(), text: this.input.value, bonus: this.input.value === 'iamking'
      ? { gameId: this.state.gameId, version: this.state.version } : undefined };
    const outgoing = this.outgoing;
    this.save(); this.sending = true; this.status.textContent = ''; this.renderControls();
    try {
      if (outgoing.bonus) {
        // 口令重试绑定最初的棋局和版本，刷新或换局后不会把旧奖励发到新局。
        const reply = await this.exchange({ p_room: this.state.room, p_client: this.client, p_operation: outgoing.id,
          p_action: 'iamking', p_game: outgoing.bonus.gameId, p_version: outgoing.bonus.version, p_protocol: 1, p_data: {} });
        if (generation !== this.generation || !reply || reply.pending) return;
        if (reply.rejection === 'undo_full') {
          // 先保存普通消息及原编号，刷新或丢回执后只重试聊天，避免重新领取奖励。
          this.outgoing = { id: outgoing.id, text: outgoing.text, undoFull: true };
          this.save();
        } else {
          this.outgoing = null;
          if (reply.accepted) this.input.value = '';
          const credited = reply.accepted && reply.gameId === outgoing.bonus.gameId;
          if (credited) this.status.textContent = bonusNotice;
          else if (reply.accepted) this.status.textContent = '上一局的悔棋奖励已确认。';
          else this.status.textContent = errorMessage(reply.rejection ?? '');
          this.save();
          // 只在本页首次确认这笔奖励时提示，双方的轮询与刷新都不会重播。
          if (credited) this.onUndoCredit();
          return;
        }
      }
      const result = await sendChat({ p_room: this.state.room, p_client: this.client, p_operation: outgoing.id, p_text: outgoing.text });
      if (generation !== this.generation) return;
      this.receive(result);
    } catch (error) {
      if (generation !== this.generation || this.outgoing?.id !== outgoing.id) return;
      // 明确拒绝才解除待确认状态；网络失败保留原 ID，供服务端去重核对。
      const definite = error instanceof RpcError && ['invalid_chat','chat_rate_limit','room_closed','expired','forbidden','superseded'].includes(error.code);
      if (definite) { this.outgoing = null; this.save(); }
      this.status.textContent = definite ? error.message : '发送尚未确认，文字已保留，请重试；不会重复发送。';
    } finally {
      if (generation === this.generation) { this.sending = false; this.renderControls(); }
    }
  }

  // 棋局快照已附带聊天；仅在面板活跃且主同步间隔较长时补读，失败后指数退避。
  private async poll() {
    if (!this.state?.chat || !this.available || this.panel.hidden || document.hidden || this.reading || this.sending
      || this.state.phase === 'closed' || Date.now() - this.activeAt >= 60000
      || Date.now() - this.lastSync < Math.min(30000, 2000 * 2 ** this.failedReads)) return;
    const generation = this.generation; this.reading = true; this.lastSync = Date.now();
    try {
      const result = await sendChat({ p_room: this.state.room, p_client: this.client, p_operation: null, p_text: null });
      if (generation !== this.generation) return;
      if (this.failedReads) this.status.textContent = '';
      this.failedReads = 0; this.receive(result);
    } catch {
      if (generation === this.generation) { this.failedReads = Math.min(4, this.failedReads + 1); this.status.textContent = '聊天同步暂时失败，稍后自动重试。'; }
    } finally { if (generation === this.generation) { this.reading = false; this.renderControls(); } }
  }
}
