/** 按完整表情步长翻页，使用实际滚动位置更新边界按钮。 */
export function setupReactionPicker(strip: HTMLElement, previous: HTMLButtonElement, next: HTMLButtonElement) {
  let target: number | null = null;
  let direction = 0;
  const limit = () => Math.max(0, strip.scrollWidth - strip.clientWidth);
  const update = () => {
    const max = limit();
    // 容忍小数像素的取整误差；隐藏容器还没有可用宽度时禁止翻页。
    previous.disabled = strip.clientWidth === 0 || strip.scrollLeft <= 1;
    next.disabled = strip.clientWidth === 0 || strip.scrollLeft >= max - 1;
  };
  const reset = () => { target = null; direction = 0; };
  const page = (step: number) => {
    update();
    if ((step < 0 ? previous : next).disabled) return;
    const first = strip.firstElementChild, second = first?.nextElementSibling;
    const stride = first && second ? second.getBoundingClientRect().left - first.getBoundingClientRect().left : strip.clientWidth;
    const distance = Math.max(stride, Math.floor((strip.clientWidth + 1) / stride) * stride);
    // 同向连点累计到待到达位置，避免平滑滚动尚未结束时多次点击落在同一页。
    const start = target !== null && direction === step ? target : strip.scrollLeft;
    target = Math.max(0, Math.min(limit(), start + step * distance));
    direction = step;
    strip.scrollTo({ left: target, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  };
  previous.onclick = () => page(-1);
  next.onclick = () => page(1);
  strip.addEventListener('scroll', update, { passive: true });
  strip.addEventListener('scrollend', () => { reset(); update(); });
  // 手动滚动会改变用户意图，应清掉尚未到达的程序翻页目标。
  strip.addEventListener('pointerdown', reset, { passive: true });
  strip.addEventListener('wheel', reset, { passive: true });
  strip.addEventListener('keydown', reset);
  const observer = new ResizeObserver(() => {
    reset();
    strip.scrollTo({ left: Math.max(0, Math.min(limit(), strip.scrollLeft)), behavior: 'instant' });
    update();
  });
  observer.observe(strip);
  update();
}
