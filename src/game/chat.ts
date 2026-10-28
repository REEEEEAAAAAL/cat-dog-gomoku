import './chat.css';
import { sendChat } from './api';
import { chatLength, validChatText } from './chat-protocol';
import type { ChatSnapshot } from './chat-protocol';
import type { Snapshot } from './protocol';
import { RpcError } from './protocol';
import { createId } from './rules';

interface Outgoing { id: string; text: string }

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
  private generation = 0;
  private readSeq = 0;
  private lastSync = 0;
  private activeAt = 0;
  private failedReads = 0;
  private inputFocusScrollY: number | null = null;

  constructor(private readonly client: string) {
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
        this.outgoing = { id: saved.id, text: saved.text }; this.input.value = saved.text;
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

  private receive(data: ChatSnapshot) {
    if (data.room !== this.state?.room || data.revision < (this.data?.revision ?? -1)) return;
    const changed = data.revision !== this.data?.revision;
    const bottom = this.atBottom();
    const anchor = Array.from(this.list.children).find(node => node.getBoundingClientRect().bottom > this.list.getBoundingClientRect().top);
    const offset = anchor ? anchor.getBoundingClientRect().top - this.list.getBoundingClientRect().top : 0;
    const anchorSeq = (anchor as HTMLElement | undefined)?.dataset.seq;
    const confirmed = this.outgoing && (data.ack === this.outgoing.id || data.messages.some(m => m.id === this.outgoing?.id && m.seat === this.state?.seat));
    const followLatest = bottom || !!confirmed;
    this.data = data;
    if (confirmed) {
      this.outgoing = null; this.input.value = ''; this.status.textContent = ''; this.save();
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
    availability.classList.toggle('chat-error', !!this.status.textContent);
    availability.textContent = this.status.textContent || (closed ? '房间已关闭，无法继续发送。'
      : !this.state?.chat ? '聊天暂不可用，请等待服务更新。'
      : !this.available ? '连接恢复后可发送，输入会保留。' : '仅保留最近 50 条 · Enter 发送，Shift+Enter 换行');
  }

  private async submit() {
    if (this.send.disabled || this.composing || !this.state) return;
    const generation = this.generation;
    this.outgoing ??= { id: createId(), text: this.input.value };
    const outgoing = this.outgoing;
    this.save(); this.sending = true; this.status.textContent = ''; this.renderControls();
    try {
      const result = await sendChat({ p_room: this.state.room, p_client: this.client, p_operation: outgoing.id, p_text: outgoing.text });
      if (generation !== this.generation) return;
      this.receive(result);
    } catch (error) {
      if (generation !== this.generation || this.outgoing?.id !== outgoing.id) return;
      const definite = error instanceof RpcError && ['invalid_chat','chat_rate_limit','room_closed','expired','forbidden','superseded'].includes(error.code);
      if (definite) { this.outgoing = null; this.save(); }
      this.status.textContent = definite ? error.message : '发送尚未确认，文字已保留，请重试；不会重复发送。';
    } finally {
      if (generation === this.generation) { this.sending = false; this.renderControls(); }
    }
  }

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
