/**
 * iOS UI building blocks.
 *
 * These exist so the views describe *what* they are showing (a grouped list, a
 * switch row, a segmented control) rather than repeating the markup each
 * pattern needs. Everything renders plain DOM through `el()`.
 */

import { el, type Child } from '../core/dom.js';
import { icon, type IconName } from '../core/icons.js';
import { haptic, supportsNativeSwitch } from '../core/platform.js';

/**
 * An inset grouped list, the iOS Settings pattern: rounded card, optional
 * uppercase header above and explanatory footer below.
 */
export function listGroup(
  options: { title?: string; footer?: string | Child },
  ...rows: Child[]
): HTMLElement {
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
  /** Leading glyph, shown in a rounded tinted square. */
  icon?: IconName;
  /** Background colour of the leading glyph's square. */
  iconColor?: string;
  label: string;
  /** Trailing secondary text. */
  value?: string | null;
  /** Shows a disclosure chevron and makes the row a button. */
  onClick?: () => void;
  /** Arbitrary trailing content — a switch, a control, a badge. */
  trailing?: Child;
  /** Renders the label in the destructive colour. */
  destructive?: boolean;
}

/** One row of a grouped list. */
export function row(options: RowOptions): HTMLElement {
  const leading = options.icon
    ? el(
        'span',
        {
          class: 'row__icon',
          style: options.iconColor
            ? `background:${options.iconColor};color:#fff`
            : undefined,
        },
        icon(options.icon, { size: 17 }),
      )
    : null;

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
  if (options.onClick) {
    trailing.push(icon('chevron-right', { size: 12, className: 'row__chevron', weight: 2.4 }));
  }

  if (!options.onClick) {
    return el('div', { class: 'row' }, leading, label, ...trailing);
  }

  return el(
    'button',
    {
      class: 'row',
      type: 'button',
      on: {
        click: () => {
          haptic('selection');
          options.onClick?.();
        },
      },
    },
    leading,
    label,
    ...trailing,
  );
}

/** A row whose trailing control is a switch. */
export function switchRow(options: {
  label: string;
  checked: boolean;
  icon?: IconName;
  iconColor?: string;
  footer?: string;
  onChange: (checked: boolean) => void;
}): HTMLElement {
  return row({
    label: options.label,
    icon: options.icon,
    iconColor: options.iconColor,
    trailing: switchControl({ checked: options.checked, onChange: options.onChange, label: options.label }),
  });
}

/**
 * A switch.
 *
 * Safari 17.4 and later render `<input type="checkbox" switch>` as the real
 * iOS control — correct animation, correct accessibility, correct feel. Where
 * that is unsupported the same element gets a CSS stand-in, so the markup and
 * the event handling never branch.
 */
export function switchControl(options: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}): HTMLInputElement {
  const input = el('input', {
    type: 'checkbox',
    class: 'switch',
    checked: options.checked,
    'aria-label': options.label,
    on: {
      change: (event) => {
        haptic('selection');
        options.onChange((event.target as HTMLInputElement).checked);
      },
    },
  });

  if (supportsNativeSwitch()) input.setAttribute('switch', '');
  return input;
}

/** A segmented control. Returns the element; selection is caller-driven. */
export function segmented<T extends string>(options: {
  options: { value: T; label: string }[];
  value: T;
  label: string;
  onChange: (value: T) => void;
}): HTMLElement {
  return el(
    'div',
    { class: 'segmented', role: 'tablist', 'aria-label': options.label },
    ...options.options.map((option) =>
      el('button', {
        class: 'segmented__option',
        type: 'button',
        role: 'tab',
        'aria-selected': String(option.value === options.value),
        text: option.label,
        on: {
          click: () => {
            if (option.value === options.value) return;
            haptic('selection');
            options.onChange(option.value);
          },
        },
      }),
    ),
  );
}

/** A filter chip. */
export function chip(options: {
  label: string;
  pressed: boolean;
  dotColor?: string;
  onToggle: () => void;
}): HTMLElement {
  return el(
    'button',
    {
      class: 'chip',
      type: 'button',
      'aria-pressed': String(options.pressed),
      on: {
        click: () => {
          haptic('selection');
          options.onToggle();
        },
      },
    },
    options.dotColor ? el('span', { class: 'pill__dot', style: `background:${options.dotColor}` }) : null,
    options.label,
  );
}

export type BannerTone = 'info' | 'warning' | 'danger' | 'success';

const BANNER_ICON: Record<BannerTone, IconName> = {
  info: 'info-circle',
  warning: 'exclamation-triangle',
  danger: 'exclamation-triangle',
  success: 'checkmark-circle',
};

/** An inline notice. */
export function banner(options: {
  tone: BannerTone;
  title?: string;
  body?: Child;
  actions?: Child;
}): HTMLElement {
  return el(
    'div',
    { class: ['banner', `banner--${options.tone}`] },
    icon(BANNER_ICON[options.tone], { size: 20, className: 'banner__icon' }),
    el(
      'div',
      { class: 'banner__body' },
      options.title ? el('strong', { text: options.title }) : null,
      typeof options.body === 'string' ? el('p', { text: options.body }) : options.body,
      options.actions,
    ),
  );
}

/** A full-height empty state. */
export function emptyState(options: {
  icon: IconName;
  title: string;
  body?: string;
  action?: Child;
}): HTMLElement {
  return el(
    'div',
    { class: 'empty-state' },
    icon(options.icon, { size: 52, className: 'empty-state__icon', weight: 1.2 }),
    el('p', { class: 'empty-state__title', text: options.title }),
    options.body ? el('p', { text: options.body }) : null,
    options.action,
  );
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
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'sheet' });

    const finish = (value: T | null): void => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };

    const group = el(
      'div',
      { class: 'sheet__group' },
      options.title ? el('p', { class: 'sheet__title', text: options.title }) : null,
      ...options.options.map((option) =>
        el('button', {
          class: 'sheet__option',
          type: 'button',
          'aria-selected': String(option.value === options.selected),
          style: option.destructive ? 'color:var(--danger)' : undefined,
          text: option.label,
          on: {
            click: () => {
              haptic('selection');
              finish(option.value);
            },
          },
        }),
      ),
    );

    const cancel = el('button', {
      class: 'sheet__option sheet__option--cancel',
      type: 'button',
      text: options.cancelLabel ?? 'Avbryt',
      on: { click: () => finish(null) },
    });

    dialog.appendChild(el('div', { class: 'sheet__body' }, group, cancel));

    // Esc and a tap on the dimmed backdrop both mean cancel.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(null);
    });

    document.body.appendChild(dialog);
    dialog.showModal();
  });
}

/** A search field with the standard leading magnifier. */
export function searchField(options: {
  value: string;
  placeholder: string;
  label: string;
  onInput: (value: string) => void;
}): HTMLElement {
  return el(
    'div',
    { class: 'search-field' },
    icon('search', { size: 16, className: 'search-field__icon', weight: 2 }),
    el('input', {
      type: 'search',
      value: options.value,
      placeholder: options.placeholder,
      'aria-label': options.label,
      enterkeyhint: 'search',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: false,
      on: { input: (event) => options.onInput((event.target as HTMLInputElement).value.trim()) },
    }),
  );
}
