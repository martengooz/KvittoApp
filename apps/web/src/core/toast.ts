/** Transient status messages, anchored above the bottom navigation. */

import { el } from './dom.js';

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

export function toast(message: string, options: ToastOptions = {}): void {
  const { kind = 'info', durationMs = kind === 'error' ? 6000 : 3500 } = options;

  const node = el(
    'div',
    { class: ['toast', `toast--${kind}`] },
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

/** Blocking confirm dialog, styled to match the app. Resolves to the choice. */
export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = el(
      'dialog',
      { class: 'dialog' },
      el(
        'form',
        { method: 'dialog', class: 'dialog__body' },
        el('h2', { class: 'dialog__title', text: options.title }),
        el('p', { class: 'dialog__message', text: options.message }),
        el(
          'div',
          { class: 'dialog__actions' },
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            text: options.cancelLabel ?? 'Avbryt',
            on: { click: () => close(false) },
          }),
          el('button', {
            class: ['btn', options.destructive ? 'btn--danger' : 'btn--primary'],
            type: 'button',
            text: options.confirmLabel ?? 'OK',
            on: { click: () => close(true) },
          }),
        ),
      ),
    );

    function close(result: boolean): void {
      dialog.close();
      dialog.remove();
      resolve(result);
    }

    // Esc and backdrop clicks both mean "cancel".
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close(false);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) close(false);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
  });
}
