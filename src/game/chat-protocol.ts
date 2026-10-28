import type { Seat } from './rules';

export interface ChatMessage { id: string; seq: number; seat: Seat; text: string; at: number }
export interface ChatSnapshot { room: string; revision: number; messages: ChatMessage[]; ack?: string; duplicate?: boolean }
export interface ChatCommand { p_room: string; p_client: string; p_operation: string | null; p_text: string | null }
export const chatLength = (text: string) => Array.from(text).length;
export const validChatText = (text: string) => text.trim().length > 0 && chatLength(text) <= 100
  && Array.from(text).every(char => { const code = char.codePointAt(0)!; return code >= 32 && code !== 127 || code === 9 || code === 10 || code === 13; });

export function isChatSnapshot(value: unknown): value is ChatSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.room !== 'string' || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0
    || !Array.isArray(v.messages) || v.messages.length > 50
    || (v.ack !== undefined && typeof v.ack !== 'string')
    || (v.duplicate !== undefined && typeof v.duplicate !== 'boolean')) return false;
  let previous = 0;
  const ids = new Set<string>();
  return v.messages.every((message: unknown) => {
    if (!message || typeof message !== 'object') return false;
    const m = message as Record<string, unknown>;
    if (typeof m.id !== 'string' || ids.has(m.id) || !Number.isSafeInteger(m.seq)
      || Number(m.seq) <= previous || Number(m.seq) > Number(v.revision) || (m.seat !== 1 && m.seat !== 2)
      || typeof m.text !== 'string' || !validChatText(m.text) || typeof m.at !== 'number' || !Number.isFinite(m.at)) return false;
    ids.add(m.id); previous = Number(m.seq); return true;
  });
}
