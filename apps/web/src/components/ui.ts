/**
 * iOS UI building blocks.
 *
 * These exist so the views describe *what* they are showing (a grouped list, a
 * switch row, a segmented control) rather than repeating the markup each
 * pattern needs. Everything renders plain DOM through `el()`.
 *
 * The grouped-list shell and the plain row shape are the same markup the AI
 * settings panel builds for the server dashboard, so that part lives in
 * `packages/shared/src/ui-rows.ts` and this file layers the app-specific
 * bits (icons, haptics, the destructive/tone variants) on top of it.
 */

import {
  parseAmount,
  listGroup as sharedListGroup,
  row as sharedRow,
  spinner as sharedSpinner,
  wireBusyAction,
  type ListGroupOptions,
  type RowOptions as SharedRowOptions,
} from '@kvitto/shared';

import { confirmDialog } from './dialog.js';
import { el, replaceChildren, type Child } from '../core/dom.js';
import { icon, type IconName } from '../core/icons.js';
import { haptic, supportsNativeSwitch } from '../core/platform.js';
import { toast } from '../core/toast.js';

/**
 * An inset grouped list, the iOS Settings pattern: rounded card, optional
 * uppercase header above and explanatory footer below.
 */
export function listGroup(options: ListGroupOptions, ...rows: Child[]): HTMLElement {
  return sharedListGroup(options, ...rows);
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

  const trailing: Child = [
    options.trailing ?? null,
    options.onClick ? icon('chevron-right', { size: 12, className: 'row__chevron', weight: 2.4 }) : null,
  ];

  const shared: SharedRowOptions = {
    label: options.label,
    value: options.value,
    leading,
    trailing,
    destructive: options.destructive,
    onClick: options.onClick
      ? () => {
          haptic('selection');
          options.onClick?.();
        }
      : undefined,
  };
  return sharedRow(shared);
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
      // Lets `preserveFocus` find this exact field again after a re-render —
      // there is only ever one search field per screen, so a fixed key is fine.
      dataset: { focusKey: 'search' },
      enterkeyhint: 'search',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: false,
      on: { input: (event) => options.onInput((event.target as HTMLInputElement).value.trim()) },
    }),
  );
}

/**
 * A tinted, centred row that acts like a button — "Ny etikett", "Synka nu",
 * "Radera all data" — the shape every list ends its actions with.
 *
 * `busyLabel` covers the self-contained busy state a handful of these need
 * (a network call the row itself waits on): the row disables, shows a
 * spinner and that label, then restores once `onClick` settles. Rows whose
 * busy state is driven by the screen re-rendering around them (a shared
 * `parsing` flag, say) should just pass an already-computed `label` and
 * `disabled` instead.
 */
export function actionRow(options: {
  label: string;
  tone?: 'tint' | 'danger';
  icon?: Child;
  disabled?: boolean;
  busyLabel?: string;
  onClick: (event: MouseEvent) => void | Promise<void>;
}): HTMLButtonElement {
  const idle = (): Child[] => [options.icon ?? null, el('span', { text: options.label })];
  const button = el(
    'button',
    {
      class: ['row', 'row--action', options.tone === 'danger' ? 'row--action--danger' : ''],
      type: 'button',
      disabled: options.disabled,
    },
    ...idle(),
  );

  if (!options.busyLabel) {
    button.addEventListener('click', (event) => void options.onClick(event));
    return button;
  }
  wireBusyAction(button, options.busyLabel, (event) => Promise.resolve(options.onClick(event)), (btn) => {
    btn.disabled = options.disabled ?? false;
    replaceChildren(btn, ...idle());
  });

  return button;
}

/**
 * A row whose control sits below its label rather than beside it — a range
 * slider, a segmented control, a block of running text — because the control
 * itself is too wide, or too tall, to share a line.
 */
export function stackedRow(options: { label: string; value?: string; control: Child }): HTMLElement {
  return el(
    'div',
    { class: 'row row--stacked' },
    options.value !== undefined
      ? el(
          'span',
          { class: 'stack stack--between' },
          el('span', { class: 'row__label', text: options.label }),
          el('span', { class: 'row__value', text: options.value }),
        )
      : el('span', { class: 'row__label', text: options.label }),
    options.control,
  );
}

/** A range input with its current value spelled out above it. */
export function sliderRow(options: {
  label: string;
  value: number;
  valueLabel: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}): HTMLElement {
  return stackedRow({
    label: options.label,
    value: options.valueLabel,
    control: el('input', {
      type: 'range',
      min: options.min,
      max: options.max,
      step: options.step ?? 1,
      value: String(options.value),
      'aria-label': options.label,
      on: {
        change: (event) => options.onChange(Number((event.target as HTMLInputElement).value)),
      },
    }),
  });
}

/** A labelled form control, for the editor's dense grids. */
export function field(label: string, control: HTMLElement): HTMLElement {
  return el('label', { class: 'field' }, el('span', { class: 'field__label', text: label }), control);
}

/**
 * A text input that accepts Swedish money formatting and normalises on blur, so
 * `12,50`, `12.50` and `12 kr` all work.
 */
export function moneyInput(
  value: number | null,
  onCommit: (value: number | null) => Promise<void> | void,
): HTMLElement {
  return el('input', {
    type: 'text',
    inputmode: 'decimal',
    value: value === null ? '' : value.toFixed(2).replace('.', ','),
    on: {
      change: (event) => {
        const input = event.target as HTMLInputElement;
        const raw = input.value.trim();
        if (!raw) {
          input.value = '';
          void onCommit(null);
          return;
        }
        const parsed = parseAmount(raw);
        if (parsed === null) {
          toast('Kunde inte tolka beloppet.', { kind: 'error' });
          input.value = value === null ? '' : value.toFixed(2).replace('.', ',');
          return;
        }
        input.value = parsed.toFixed(2).replace('.', ',');
        void onCommit(parsed);
      },
    },
  });
}

/** A small spinner, for a busy button or an inline loading row. */
export function spinner(options: { size?: number; className?: string } = {}): HTMLElement {
  return sharedSpinner(options);
}

/**
 * A centred "working on it" state: a spinner, a title, and optionally a line
 * explaining what is happening. `extra` appends further content below that —
 * a filename, a progress bar — for the screens that need more than text.
 */
export function loadingState(
  options: { title: string; body?: string; className?: string },
  ...extra: Child[]
): HTMLElement {
  return el(
    'div',
    { class: ['empty-state', options.className] },
    spinner({ size: 28 }),
    el('p', { class: 'empty-state__title', text: options.title }),
    options.body ? el('p', { text: options.body }) : null,
    ...extra,
  );
}

/**
 * The icon button + confirm dialog every delete action in the app uses.
 *
 * `confirmDialog` lives in `components/dialog.js`; this just wires it to a
 * trash icon so the 3 call sites don't each restate the same options object.
 */
export function deleteButton(options: {
  label: string;
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}): HTMLElement {
  return el(
    'button',
    {
      class: 'btn btn--sm btn--icon btn--danger-plain',
      type: 'button',
      'aria-label': options.label,
      on: {
        click: async () => {
          const confirmed = await confirmDialog({
            title: options.title,
            message: options.message,
            confirmLabel: options.confirmLabel ?? 'Ta bort',
            destructive: true,
          });
          if (confirmed) await options.onConfirm();
        },
      },
    },
    icon('trash', { size: 18 }),
  );
}
