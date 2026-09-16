/**
 * The iOS "grouped list" row vocabulary shared by the web app's Settings
 * screens and the AI settings panel served to the server dashboard. Both
 * render the same `list-group` / `inset-list` / `row` markup and the same
 * busy-button spinner, so it lives here once instead of as two copies that
 * must be kept in visual sync by hand.
 *
 * Like `dom.ts`, this file is served to the browser unbundled (see
 * `apps/server/src/dashboard.ts`), so it stays dependency-free apart from
 * the sibling `dom.ts` — no Node APIs, no bare-specifier imports.
 */

import { el, type Child } from './dom.js';

export interface ListGroupOptions {
  title?: string;
  footer?: string | Child;
}

/**
 * An inset grouped list: rounded card, optional uppercase header above and
 * explanatory footer below.
 */
export function listGroup(options: ListGroupOptions, ...rows: Child[]): HTMLElement {
  return el(
    'section',
    { class: 'list-group' },
    options.title ? el('h2', { class: 'list-group__title', text: options.title }) : null,
    el('div', { class: 'inset-list' }, ...rows),
    options.footer
      ? typeof options.footer === 'string'
        ? el('p', { class: 'list-group__footer', text: options.footer })
        : el('p', { class: 'list-group__footer' }, options.footer)
      : null,
  );
}

export interface RowOptions {
  label: string;
  /** Trailing secondary text. */
  value?: string | null;
  /** Leading content — an icon, typically — already built by the caller. */
  leading?: Child;
  /** Arbitrary trailing content, appended after `value`. */
  trailing?: Child;
  /** Renders the label in the destructive colour. */
  destructive?: boolean;
  /** Makes the row a `button.row` instead of a plain `div.row`. */
  onClick?: (event: MouseEvent) => void;
}

/** One row of a grouped list. */
export function row(options: RowOptions): HTMLElement {
  const label = el('span', {
    class: 'row__label',
    text: options.label,
    style: options.destructive ? 'color:var(--danger)' : undefined,
  });

  const trailing: Child[] = [];
  if (options.value !== undefined && options.value !== null) {
    trailing.push(el('span', { class: 'row__value', text: options.value }));
  }
  if (options.trailing) trailing.push(options.trailing);

  if (!options.onClick) {
    return el('div', { class: 'row' }, options.leading, label, ...trailing);
  }
  return el('button', { class: 'row', type: 'button', on: { click: options.onClick } }, options.leading, label, ...trailing);
}

/** A labelled row whose trailing content is a form control. */
export function fieldRow(label: string, control: Child): HTMLElement {
  return el('label', { class: 'row' }, el('span', { class: 'row__label', text: label }), control);
}

/** A read-only label/value row, for status displays. */
export function valueRow(label: string, value: string): HTMLElement {
  return row({ label, value });
}

/**
 * A row whose control sits below its label rather than beside it, because
 * the control itself is too tall to share a line — a block of running text,
 * for instance.
 */
export function stackedRow(label: string, control: Child): HTMLElement {
  return el('label', { class: 'row row--stacked' }, el('span', { class: 'row__label', text: label }), control);
}

/**
 * A field row with a checkbox switch, wired to call `onChange` with the new
 * value. `className` lets each caller supply its own switch styling — the
 * web app's `.switch` (with native `switch` attribute support) and the
 * dashboard's `.toggle` fallback are visually distinct, so this does not
 * pick one for them.
 */
export function toggleRow(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
  className = 'switch',
): HTMLElement {
  const control = el('input', {
    class: className,
    type: 'checkbox',
    checked,
    'aria-label': label,
    on: { change: (event) => onChange((event.target as HTMLInputElement).checked) },
  });
  return fieldRow(label, control);
}

/** A small spinner, for a busy button or an inline loading row. */
export function spinner(options: { size?: number; className?: string } = {}): HTMLElement {
  return el('div', {
    class: ['spinner', options.className],
    'aria-hidden': 'true',
    style: options.size ? `width:${options.size}px;height:${options.size}px` : undefined,
  });
}

/**
 * Wires `button` to disable, show a spinner and `busyLabel`, and run
 * `action`. Both the web app's action rows (which just revert to idle once
 * the promise settles) and the AI settings action rows (which show the
 * result as the row's new label) need the exact same
 * disable/spinner/aria-busy sequence; `onSettle` is where they diverge, and
 * it is responsible for restoring `disabled` and the row's final content.
 */
export function wireBusyAction(
  button: HTMLButtonElement,
  busyLabel: string,
  action: (event: MouseEvent) => Promise<unknown>,
  onSettle: (button: HTMLButtonElement, result: unknown, error: unknown) => void,
): void {
  button.addEventListener('click', (event) => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.replaceChildren(spinner({ className: 'action-spinner' }), el('span', { text: busyLabel }));
    void Promise.resolve()
      .then(() => action(event))
      .then(
        (result) => onSettle(button, result, undefined),
        (error: unknown) => onSettle(button, undefined, error),
      )
      .finally(() => button.removeAttribute('aria-busy'));
  });
}

/**
 * A tinted, centred row that acts like a button and, once `action` settles,
 * shows its result (a string, or an `{ message }` it resolved with) as the
 * row's new label, falling back to an error's message — the AI settings
 * panel's "Testa anslutningen" / "Starta" / "Läs kvitton nu" rows.
 */
export function actionRow(label: string, action: () => Promise<unknown>, pendingLabel = 'Arbetar…'): HTMLElement {
  const button = el('button', { class: 'row', type: 'button', text: label }) as HTMLButtonElement;
  button.style.color = 'var(--tint)';
  button.style.justifyContent = 'center';
  wireBusyAction(button, pendingLabel, action, (btn, result, error) => {
    let resultLabel = label;
    if (error !== undefined) {
      resultLabel = (error instanceof Error ? error.message : String(error));
    } else if (typeof result === 'string') {
      resultLabel = result;
    } else if (result && typeof result === 'object' && 'message' in result && typeof (result as { message: unknown }).message === 'string') {
      resultLabel = (result as { message: string }).message;
    }
    btn.textContent = resultLabel;
    btn.disabled = false;
  });
  return button;
}
