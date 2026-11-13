// The outlines that stay on the page after a fill (the client, 2026-11-13: show
// staff on the site where a bill went wrong). One box around each row or field
// the person still has to enter (red) or check (amber), with a short tag, until
// its card is ticked in the panel or the bill is cleared — or "Hide" is pressed.
//
// Drawn in FillPilot's own layer over the page (a shadow root, click-through):
// the site's elements are not changed, and nothing is typed or clicked.
// content.js is injected again on every call from the panel, so the layer's
// state lives on this isolated world's global, where the next copy finds it.

import type { PageMark, PageSpot } from '../../../web/projects/shared/src/page-contract';

interface MarkLayer {
  host: HTMLElement;
  timer: number;
  onMove: () => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __fillpilotMarks: MarkLayer | undefined;
}

const STYLE = `
  :host { all: initial; }
  .box { position: absolute; display: none; box-sizing: border-box; border: 2px solid; border-radius: 6px; }
  .box.enter { border-color: #e5484d; background: rgba(229, 72, 77, 0.07); }
  .box.check { border-color: #e8930c; background: rgba(245, 165, 36, 0.08); }
  .tag {
    position: absolute; top: 0; right: 8px; transform: translateY(-60%); max-width: 260px; overflow: hidden; text-overflow: ellipsis;
    font: 600 10.5px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #fff; padding: 0 7px; border-radius: 999px;
    white-space: nowrap; pointer-events: auto; cursor: default; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  }
  .tag.below { top: 100%; transform: translateY(-40%); }
  .enter .tag { background: #d6335c; }
  .check .tag { background: #b26a00; }
  .chip {
    position: absolute; right: 14px; bottom: 14px; display: none; align-items: center; gap: 8px; pointer-events: auto;
    font: 500 12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; color: #14162e; background: #fff;
    border: 1px solid #d0d4ea; border-radius: 999px; padding: 5px 6px 5px 12px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.18);
  }
  .chip b { font-weight: 700; }
  .chip .red { color: #d6335c; }
  .chip .amber { color: #b26a00; }
  .chip button { font: inherit; border: 0; border-radius: 999px; padding: 3px 10px; background: #eef0ff; color: #14162e; cursor: pointer; }
  .chip button:hover { background: #dfe3ff; }
`;

/** Takes the page's outlines away (nothing of the site was changed, so nothing else to undo). */
export function removeMarks(): void {
  const layer = globalThis.__fillpilotMarks;
  if (!layer) return;
  window.clearInterval(layer.timer);
  window.removeEventListener('scroll', layer.onMove, true);
  window.removeEventListener('resize', layer.onMove);
  layer.host.remove();
  globalThis.__fillpilotMarks = undefined;
}

const shown = (el: HTMLElement) => {
  if (!el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

/**
 * Replaces the outlines with these. `find` gives the elements of a spot (the
 * same lookup as "Show on site"); it runs again every second, as the site
 * redraws its tables and switches tabs. → how many are on the page now.
 */
export function setMarks(marks: PageMark[], find: (spot: PageSpot) => HTMLElement[]): number {
  removeMarks();
  if (!marks.length) return 0;

  const host = document.createElement('div');
  host.setAttribute('data-fillpilot', 'marks');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  // Closed: the profile's own look-ups (buttons, fields, page text) never see this layer.
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);

  const boxes = marks.map((m) => {
    const box = document.createElement('div');
    box.className = `box ${m.level}`;
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = m.tag;
    if (m.detail) tag.title = m.detail;
    box.append(tag);
    root.append(box);
    return { m, box, tag, els: [] as HTMLElement[] };
  });

  // Bottom right: how many are on this page, and a way to take them away.
  const chip = document.createElement('div');
  chip.className = 'chip';
  const count = document.createElement('span');
  const hide = document.createElement('button');
  hide.type = 'button';
  hide.textContent = 'Hide';
  hide.title = 'Take FillPilot\'s outlines off this page (the panel still lists them)';
  hide.addEventListener('click', () => removeMarks());
  chip.append(count, hide);
  root.append(chip);

  /** Measures again — on scroll, only where the boxes are. */
  const place = () => {
    let red = 0;
    let amber = 0;
    for (const b of boxes) {
      const els = b.els.filter(shown);
      if (!els.length) {
        b.box.style.display = 'none';
        continue;
      }
      const rects = els.map((e) => e.getBoundingClientRect());
      const left = Math.min(...rects.map((r) => r.left)) - 3;
      const top = Math.min(...rects.map((r) => r.top)) - 3;
      const right = Math.max(...rects.map((r) => r.right)) + 3;
      const bottom = Math.max(...rects.map((r) => r.bottom)) + 3;
      Object.assign(b.box.style, { display: 'block', left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      b.tag.classList.toggle('below', top < 14);
      if (b.m.level === 'enter') red++;
      else amber++;
    }
    const parts = [
      ...(red ? [`<span class="red"><b>${red}</b> to enter</span>`] : []),
      ...(amber ? [`<span class="amber"><b>${amber}</b> to check</span>`] : []),
    ];
    count.innerHTML = `FillPilot: ${parts.join(' · ')}`;
    chip.style.display = red + amber ? 'flex' : 'none';
    return red + amber;
  };
  /** Looks the rows and fields up again (the site may have redrawn them), then measures. */
  const refind = () => {
    for (const b of boxes) {
      try {
        b.els = find(b.m.spot);
      } catch {
        b.els = [];
      }
    }
    return place();
  };

  let frame = 0;
  const onMove = () => {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; place(); });
  };
  window.addEventListener('scroll', onMove, true);
  window.addEventListener('resize', onMove);
  const timer = window.setInterval(refind, 1000);
  document.documentElement.append(host);
  globalThis.__fillpilotMarks = { host, timer, onMove };
  return refind();
}
