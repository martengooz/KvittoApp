/**
 * Line icons drawn in the manner of SF Symbols.
 *
 * SF Symbols itself cannot be redistributed with a web app, so these are
 * original paths drawn to the same conventions: a 24-unit grid, rounded caps
 * and joins, and a stroke weight that matches SF Symbols' Regular. They inherit
 * `currentColor`, so a tinted parent tints the icon.
 */

import { svg } from './dom.js';

export type IconName =
  | 'receipt'
  | 'search'
  | 'plus'
  | 'tag'
  | 'gear'
  | 'chevron-right'
  | 'chevron-left'
  | 'camera'
  | 'photo'
  | 'sparkles'
  | 'checkmark'
  | 'checkmark-circle'
  | 'exclamation-triangle'
  | 'info-circle'
  | 'xmark'
  | 'xmark-circle'
  | 'trash'
  | 'rotate'
  | 'share'
  | 'crop'
  | 'arrow-up-arrow-down'
  | 'cloud'
  | 'compass';

/**
 * Path data per icon. Every entry is drawn on a 24x24 grid.
 *
 * `fill` marks the solid glyphs — the status icons that need to read at 20 px
 * inside a banner, where an outline would disappear.
 */
const PATHS: Record<IconName, { d: string[]; fill?: boolean }> = {
  receipt: {
    d: [
      'M6 3.5h12a.5.5 0 0 1 .5.5v16.2a.3.3 0 0 1-.46.25L16 19l-2 1.5L12 19l-2 1.5L8 19l-2.04 1.45a.3.3 0 0 1-.46-.25V4a.5.5 0 0 1 .5-.5Z',
      'M9 8h6',
      'M9 11.5h6',
      'M9 15h3.5',
    ],
  },
  search: { d: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm16.2 16.2 4.3 4.3'] },
  plus: { d: ['M12 5.5v13', 'M5.5 12h13'] },
  tag: {
    d: [
      'M12.6 3.5H19a1.5 1.5 0 0 1 1.5 1.5v6.4a2 2 0 0 1-.6 1.42l-6.98 6.98a2 2 0 0 1-2.83 0l-5.4-5.4a2 2 0 0 1 0-2.82l6.99-6.99a2 2 0 0 1 1.41-.59Z',
      'M16.25 8.25h.01',
    ],
  },
  gear: {
    d: [
      'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z',
      'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19.3a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.54 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.54a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15.1 4.7a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.46 9v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.03Z',
    ],
  },
  'chevron-right': { d: ['m9 5 7 7-7 7'] },
  'chevron-left': { d: ['m15 5-7 7 7 7'] },
  camera: {
    d: [
      'M4.5 8.5h2.7a1 1 0 0 0 .83-.45l1.14-1.7a1 1 0 0 1 .83-.45h4a1 1 0 0 1 .83.45l1.14 1.7a1 1 0 0 0 .83.45h2.7A1.5 1.5 0 0 1 21 10v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18v-8a1.5 1.5 0 0 1 1.5-1.5Z',
      'M12 16.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z',
    ],
  },
  photo: {
    d: [
      'M4.5 4.5h15A1.5 1.5 0 0 1 21 6v12a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18V6a1.5 1.5 0 0 1 1.5-1.5Z',
      'M8.5 11a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Z',
      'm3.5 16.5 4.6-4.1a1.5 1.5 0 0 1 2 .02l3.1 2.9a1.5 1.5 0 0 0 2.04 0l1.7-1.55a1.5 1.5 0 0 1 2.03.01l2.03 1.87',
    ],
  },
  sparkles: {
    d: [
      'M12 3.5 13.6 8 18 9.6 13.6 11.2 12 15.7 10.4 11.2 6 9.6 10.4 8 12 3.5Z',
      'M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z',
      'M5.5 14l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6Z',
    ],
  },
  checkmark: { d: ['m5 12.8 4.6 4.7L19 7.5'] },
  'checkmark-circle': {
    fill: true,
    d: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.78 7.7-5.4 6.3a1 1 0 0 1-1.48.05l-2.7-2.7a1 1 0 0 1 1.42-1.42l1.93 1.94 4.71-5.48a1 1 0 1 1 1.52 1.3Z'],
  },
  'exclamation-triangle': {
    fill: true,
    d: ['M13.7 3.9a2 2 0 0 0-3.4 0L2.5 17.4A2 2 0 0 0 4.2 20.5h15.6a2 2 0 0 0 1.7-3.1L13.7 3.9ZM12 8a1 1 0 0 1 1 1v4.5a1 1 0 1 1-2 0V9a1 1 0 0 1 1-1Zm0 8.2a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3Z'],
  },
  'info-circle': {
    fill: true,
    d: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 4.3a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4ZM13 17a1 1 0 1 1-2 0v-6a1 1 0 1 1 2 0v6Z'],
  },
  xmark: { d: ['m6 6 12 12', 'm18 6-12 12'] },
  'xmark-circle': {
    fill: true,
    d: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm3.5 12.1a1 1 0 0 1-1.4 1.4L12 13.4l-2.1 2.1a1 1 0 0 1-1.4-1.4l2.1-2.1-2.1-2.1a1 1 0 1 1 1.4-1.4l2.1 2.1 2.1-2.1a1 1 0 0 1 1.4 1.4L13.4 12l2.1 2.1Z'],
  },
  trash: {
    d: [
      'M4.5 6.5h15',
      'M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5',
      'M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5',
      'M10.5 10v6.5',
      'M13.5 10v6.5',
    ],
  },
  rotate: {
    d: ['M20 12a8 8 0 1 1-2.5-5.8', 'M20.5 4v4.5H16'],
  },
  share: {
    d: ['M12 15.5V3.5', 'm8.2 7.2 3.8-3.7 3.8 3.7', 'M6 12.5H5A1.5 1.5 0 0 0 3.5 14v5A1.5 1.5 0 0 0 5 20.5h14a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 19 12.5h-1'],
  },
  crop: {
    d: ['M6.5 2.5v13a1.5 1.5 0 0 0 1.5 1.5h13', 'M2.5 6.5h13a1.5 1.5 0 0 1 1.5 1.5v13'],
  },
  'arrow-up-arrow-down': {
    d: ['M7 20V5', 'm3.5 8.5 3.5-4 3.5 4', 'M17 4v15', 'm13.5 15.5 3.5 4 3.5-4'],
  },
  cloud: {
    d: ['M7 18.5h10.2a3.8 3.8 0 0 0 .5-7.56 5.75 5.75 0 0 0-11.13-1.2A3.9 3.9 0 0 0 7 18.5Z'],
  },
  compass: {
    d: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'm15.2 8.8-2.05 4.35-4.35 2.05 2.05-4.35 4.35-2.05Z'],
  },
};

export interface IconOptions {
  /** Rendered size in pixels. Defaults to the CSS-inherited 1em box. */
  size?: number;
  className?: string;
  /** Stroke weight for outline glyphs. SF Symbols Regular is ~1.6 at this grid. */
  weight?: number;
}

/** Builds an icon as an inline SVG element. */
export function icon(name: IconName, options: IconOptions = {}): SVGSVGElement {
  const spec = PATHS[name];
  const { size, className, weight = 1.6 } = options;

  const attrs: Record<string, string | number> = {
    viewBox: '0 0 24 24',
    fill: spec.fill ? 'currentColor' : 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  if (size !== undefined) {
    attrs['width'] = size;
    attrs['height'] = size;
  }
  if (className) attrs['class'] = className;

  if (!spec.fill) {
    attrs['stroke'] = 'currentColor';
    attrs['stroke-width'] = weight;
    attrs['stroke-linecap'] = 'round';
    attrs['stroke-linejoin'] = 'round';
  }

  return svg('svg', attrs, ...spec.d.map((d) => svg('path', { d })));
}
