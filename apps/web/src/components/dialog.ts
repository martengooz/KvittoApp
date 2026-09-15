/**
 * The native `<dialog>` lifecycle, once.
 *
 * Every modal in the app — a confirm alert, an action sheet, a prompt, the
 * debug log's entry viewer — is append → `showModal()` → treat Esc and a
 * backdrop click as cancel → remove on close. {@link modal} is that sequence;
 * everything else here just decides what to put inside one and what value it
 * resolves to.
 */

import { el, replaceChildren, type Child } from '../core/dom.js';
import { haptic } from '../core/platform.js';

export interface ModalHandle<T> {
  dialog: HTMLDialogElement;
  /** Resolves to whatever value first closed the dialog. */
  result: Promise<T>;
  close: (value: T) => void;
}

/**
 * Mounts a `<dialog>` and hands back a `close` function for the content to
 * call. Esc and a tap on the dimmed backdrop both resolve to `dismissValue`,
 * same as tapping a "Cancel" button would.
 */
export function modal<T>(options: {
  class?: string | (string | null | undefined | false)[];
  dismissValue: T;
  render: (close: (value: T) => void) => Child;
}): ModalHandle<T> {
  let resolve!: (value: T) => void;
  const result = new Promise<T>((r) => {
    resolve = r;
  });

  const dialog = el('dialog', { class: options.class });
  let closed = false;
  const close = (value: T): void => {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.remove();
    resolve(value);
  };

  replaceChildren(dialog, options.render(close));

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close(options.dismissValue);
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) close(options.dismissValue);
  });

  document.body.appendChild(dialog);
  dialog.showModal();

  return { dialog, result, close };
}

/** Blocking confirm dialog, styled to match the app. Resolves to the choice. */
export function confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}): Promise<boolean> {
  const { result } = modal<boolean>({
    class: 'dialog',
    dismissValue: false,
    render: (close) =>
      el(
        'form',
        { method: 'dialog', class: 'dialog__body' },
        el(
          'div',
          { class: 'dialog__content' },
          el('h2', { class: 'dialog__title', text: options.title }),
          el('p', { class: 'dialog__message', text: options.message }),
        ),
        el(
          'div',
          { class: 'dialog__actions' },
          el('button', {
            class: 'btn',
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
  });
  return result;
}

/** A single-line text prompt, styled to match the app rather than `window.prompt`. */
export function promptDialog(options: {
  title: string;
  label: string;
  value?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  let input!: HTMLInputElement;

  const { dialog, result } = modal<string | null>({
    class: 'dialog',
    dismissValue: null,
    render: (close) => {
      const submit = (): void => close(input.value.trim() || null);
      input = el('input', {
        type: 'text',
        value: options.value ?? '',
        'aria-label': options.label,
        on: {
          keydown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          },
        },
      });
      return el(
        'form',
        { method: 'dialog', class: 'dialog__body' },
        el(
          'div',
          { class: 'dialog__content' },
          el('h2', { class: 'dialog__title', text: options.title }),
          input,
        ),
        el(
          'div',
          { class: 'dialog__actions' },
          el('button', { class: 'btn', type: 'button', text: 'Avbryt', on: { click: () => close(null) } }),
          el('button', {
            class: 'btn btn--primary',
            type: 'button',
            text: options.confirmLabel ?? 'OK',
            on: { click: submit },
          }),
        ),
      );
    },
  });

  // showModal() has already run; focusing now (rather than via `autofocus`)
  // also selects the placeholder text so replacing it is a single keystroke.
  queueMicrotask(() => {
    if (dialog.isConnected) input.select();
  });

  return result;
}

export interface ActionSheetOption<T extends string> {
  value: T;
  label: string;
  destructive?: boolean;
}

/**
 * An action sheet: the iOS way to pick one of several options.
 *
 * Used instead of a segmented control wherever the choices are too many or too
 * wordy to fit across the screen — a five-option segmented control truncates
 * every label to "Datu…" and reads as broken.
 *
 * Resolves to the chosen value, or `null` if dismissed.
 */
export function actionSheet<T extends string>(options: {
  title?: string;
  options: ActionSheetOption<T>[];
  selected?: T;
  cancelLabel?: string;
}): Promise<T | null> {
  const { result } = modal<T | null>({
    class: 'sheet',
    dismissValue: null,
    render: (close) => {
      const group = el(
        'div',
        { class: 'sheet__group' },
        options.title ? el('p', { class: 'sheet__title', text: options.title }) : null,
        ...options.options.map((option) =>
          el('button', {
            class: ['sheet__option', option.destructive ? 'sheet__option--danger' : ''],
            type: 'button',
            'aria-selected': String(option.value === options.selected),
            text: option.label,
            on: {
              click: () => {
                haptic('selection');
                close(option.value);
              },
            },
          }),
        ),
      );

      const cancel = el('button', {
        class: 'sheet__option sheet__option--cancel',
        type: 'button',
        text: options.cancelLabel ?? 'Avbryt',
        on: { click: () => close(null) },
      });

      return el('div', { class: 'sheet__body' }, group, cancel);
    },
  });
  return result;
}
