import { describe, expect, it } from 'vitest';
import { chatLength, isChatSnapshot, validChatText } from '../src/game/chat-protocol';

describe('chat protocol', () => {
  it('validates code points and blank/control input consistently', () => {
    expect(chatLength('你😀')).toBe(2);
    for (const text of ['',' \n\t　 \uFEFF','x\u0000','x\u0001','x\u007f','😀'.repeat(101)]) expect(validChatText(text)).toBe(false);
    for (const text of ['😀'.repeat(100),'你好\n朋友','<b>文本</b>']) expect(validChatText(text)).toBe(true);
  });
  it('rejects invalid ordering, duplicate IDs, oversized history and unsafe revisions', () => {
    const message={id:'one',seq:1,seat:1,text:'你好',at:1};
    const snapshot={room:'room',revision:2,messages:[message]};
    expect(isChatSnapshot(snapshot)).toBe(true);
    for (const messages of [[message,{...message,seq:2}],[{...message,seq:2},{...message,id:'two'}],Array(51).fill(message)]) {
      expect(isChatSnapshot({...snapshot,messages})).toBe(false);
    }
    expect(isChatSnapshot({...snapshot,revision:NaN})).toBe(false);
    expect(isChatSnapshot({...snapshot,messages:[{...message,seq:3}]})).toBe(false);
  });
});
