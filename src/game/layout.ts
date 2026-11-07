type RoomLayout = 'phone' | 'stacked' | 'wide';

/** 房间 DOM 挂载后调用一次，安装页面生命周期内的布局监听，返回状态更新函数。 */
export function setupRoomLayout() {
  const element = (id: string) => document.getElementById(id)!;
  const room = element('room');
  // 移动同一批节点以保留事件和控件状态；注释锚点记录原位，切回手机布局时按原序复位。
  const origins = new Map<HTMLElement, Comment>();
  const movable = ['turnBar', 'opponentPlayer', 'selfPlayer', 'interactionControls',
    'moveControls', 'undoPanel', 'rematchPanel', 'applicationPanel',
    'lobbyPanel', 'invitePanel', 'rules', 'roomCompanions', 'chatToggle', 'connectionBar', 'leave', 'closeRoom', 'tabletFooter'];
  for (const id of movable) {
    const node = element(id);
    const marker = document.createComment(`${id} layout origin`);
    node.parentNode!.insertBefore(marker, node);
    origins.set(node, marker);
  }
  const restore = (id: string) => {
    const node = element(id);
    const marker = origins.get(node)!;
    if (marker.nextSibling !== node) marker.parentNode!.insertBefore(node, marker.nextSibling);
  };
  const move = (id: string, target: string) => {
    const node = element(id), parent = element(target);
    if (node.parentElement !== parent) parent.appendChild(node);
  };
  let phase = '';
  let previous = '';
  let artVisible = false;
  const rules = element('rules') as HTMLDetailsElement;
  const update = () => {
    const style = getComputedStyle(room);
    // 断点以 CSS 为唯一来源，JS 只按模式迁移节点，避免两套尺寸条件漂移。
    const mode = style.getPropertyValue('--room-layout').trim() as RoomLayout;
    const compact = style.getPropertyValue('--room-compact').trim() === '1';
    room.dataset.phase = phase;
    const key = mode;
    room.dataset.compact = String(compact);
    if (key !== previous) {
      const focused = document.activeElement;
      for (const id of movable) restore(id);
      room.dataset.layout = mode;
      element('desktopActions').hidden = mode !== 'wide';
      if (mode === 'wide') {
        move('turnBar', 'asideTurn');
        for (const id of ['opponentPlayer', 'selfPlayer']) move(id, 'asidePlayers');
        for (const id of ['rematchPanel', 'applicationPanel', 'lobbyPanel', 'invitePanel']) move(id, 'asideActivity');
        move('undoPanel', 'negotiationDialog');
        move('roomCompanions', 'asideExtras');
        move('moveControls', 'desktopActions');
        move('interactionControls', 'moveControls');
        move('chatToggle', 'moveControls');
      } else if (mode === 'stacked') {
        for (const id of ['opponentPlayer', 'selfPlayer']) move(id, 'compactPlayers');
        move('undoPanel', 'negotiationDialog');
        move('rematchPanel', 'tabletNotices');
        move('interactionControls', 'moveControls');
        move('chatToggle', 'moveControls');
      }
      if (mode !== 'phone') move('rules', 'playArea');
      if (mode === 'stacked') {
        move('tabletFooter', 'roomAside');
      }
      if (mode !== 'phone') rules.open = false;
      if (focused instanceof HTMLElement && focused !== document.body && focused.isConnected) focused.focus({ preventScroll: true });
      previous = key;
    }
    if (mode === 'wide') {
      const activity = element('asideActivity').getBoundingClientRect();
      const panels = ['rematchPanel', 'applicationPanel', 'lobbyPanel', 'invitePanel'];
      const contentBottom = panels.reduce((bottom, id) => {
        const node = element(id);
        if (node.hidden) return bottom;
        const margin = parseFloat(getComputedStyle(node).marginBottom);
        return Math.max(bottom, node.getBoundingClientRect().bottom + margin);
      }, activity.top);
      const available = activity.bottom - contentBottom;
      const threshold = element('board').getBoundingClientRect().height / 4;
      // 显示门槛比隐藏门槛高 12px，防止插画自身影响可用空间后反复切换。
      artVisible = available >= threshold + (artVisible ? 0 : 12);
      room.dataset.art = String(artVisible);
    } else {
      artVisible = false;
      delete room.dataset.art;
    }
    if (mode !== 'wide') {
      if (mode === 'phone' && phase === 'waiting') move('lobbyPanel', 'readySlot');
      else restore('lobbyPanel');
    }
    if (mode === 'phone') {
      const card = element('selfPlayer').firstElementChild;
      if (card && element('chatToggle').parentElement !== card) card.appendChild(element('chatToggle'));
    }
    const tabletActive = mode === 'stacked' && !room.hidden && !element('playArea').hidden;
    element('tabletFooter').hidden = !tabletActive;
    if (tabletActive) {
      move('connectionBar', 'tabletFooter'); move('leave', 'tabletFooter'); move('closeRoom', 'tabletFooter');
    } else {
      restore('leave');
      if (mode === 'wide' && !room.hidden && !element('playArea').hidden) {
        move('connectionBar', 'room'); move('closeRoom', 'room');
      } else { restore('connectionBar'); restore('closeRoom'); }
    }
    const dialog = element('negotiationDialog') as HTMLDialogElement;
    const negotiating = mode !== 'phone' && !room.hidden && !element('undoPanel').hidden;
    const chatPanel = element('chatPanel');
    // 模态 dialog 使外部节点不可交互；协商期间把聊天移入顶层对话框以保留聊天能力。
    const chatParent = negotiating ? dialog : document.body;
    if (chatPanel.parentElement !== chatParent) chatParent.appendChild(chatPanel);
    if (negotiating && !dialog.open) dialog.showModal();
    else if (!negotiating && dialog.open) dialog.close();
  };
  element('negotiationDialog').addEventListener('cancel', event => event.preventDefault());
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  let scheduled = 0;
  // 将尺寸观察合并到下一帧，避免在 ResizeObserver 回调内立即改布局形成同步循环。
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(update);
  });
  for (const id of ['board', 'asideActivity', 'asideTurn', 'asidePlayers', 'moveControls', 'undoPanel', 'rematchPanel', 'applicationPanel', 'lobbyPanel', 'invitePanel']) observer.observe(element(id));
  update();
  return (nextPhase: string) => { phase = nextPhase; update(); };
}
