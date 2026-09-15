/** Transient status messages, anchored above the bottom navigation. */

import { el } from './dom.js';
import { icon, type IconName } from './icons.js';
import { haptic } from './platform.js';

export type ToastKind = 'info' | 'success' | 'error';

let host: HTMLElement | null = null;

function ensureHost(): HTMLElement {
  host ??= document.body.appendChild(
    el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' }),
  );
  return host;
}

export interface ToastOptions {
  kind?: ToastKind;
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}

const TOAST_ICON: Record<ToastKind, IconName> = {
  info: 'info-circle',
  success: 'checkmark-circle',
  error: 'xmark-circle',
};

export function toast(message: string, options: ToastOptions = {}): void {
  const { kind = 'info', durationMs = kind === 'error' ? 6000 : 3500 } = options;
  haptic(kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'selection');

  const node = el(
    'div',
    { class: ['toast', `toast--${kind}`] },
    icon(TOAST_ICON[kind], { size: 20, className: 'toast__icon' }),
    el('span', { class: 'toast__message', text: message }),
    options.action
      ? el('button', {
          class: 'toast__action',
          type: 'button',
          text: options.action.label,
          on: {
            click: () => {
              options.action?.onClick();
              dismiss(node);
            },
          },
        })
      : null,
  );

  ensureHost().appendChild(node);
  // Next frame, so the entry transition has a starting state to animate from.
  requestAnimationFrame(() => node.classList.add('toast--visible'));
  setTimeout(() => dismiss(node), durationMs);
}

function dismiss(node: HTMLElement): void {
  if (!node.isConnected) return;
  node.classList.remove('toast--visible');
  node.addEventListener('transitionend', () => node.remove(), { once: true });
  // Belt and braces: if the transition never fires (reduced motion, hidden
  // tab), remove it anyway so toasts cannot pile up invisibly.
  setTimeout(() => node.remove(), 500);
}
