/**
 * Basalt's mark — the columnar basalt prism from the app icon — as an Obsidian icon.
 *
 * Obsidian's icon set is Lucide, which has no entry for a product logo, so the mark is
 * registered with `addIcon()`. That API takes the *inner* SVG markup only and supplies its own
 * `<svg>` wrapper with a `0 0 100 100` viewBox, so these coordinates are traced from the
 * 1024px app icon and scaled by 100/1024.
 *
 * `fill="currentColor"` is required, not cosmetic: the ribbon and the status bar recolour icons
 * by setting `color`, and a hardcoded fill would stay black in a dark theme.
 *
 * The four facets are drawn as separate paths rather than one outline, because the gaps between
 * them are the mark — a single merged silhouette reads as a blob at 18px.
 */

import { addIcon } from 'obsidian';

export const BASALT_ICON_ID = 'basalt-prism';

/**
 * The traced facets sit in roughly x 31–68, y 21–79 — the proportions of the app icon, which
 * is drawn with generous padding because it renders inside a rounded app tile. A ribbon icon
 * has no tile, so that padding just makes the mark look shrunken next to Lucide's glyphs. The
 * matrix scales it about its own centre to fill the box: 1.52× with the centre held at (50,50).
 */
const BASALT_ICON_SVG = `
<g transform="matrix(1.52 0 0 1.52 -25.77 -25.47)">
  <path fill="currentColor" d="M40.7 22.5 L33.3 43.6 L47.7 49.6 Z" />
  <path fill="currentColor" d="M42.7 20.7 L56.9 28.5 L68.4 45.1 L49.6 50.4 Z" />
  <path fill="currentColor" d="M33.1 44.7 L47.1 50.8 L45.1 78.1 L31.3 68.4 Z" />
  <path fill="currentColor" d="M50.4 53.2 L68.4 46.1 L63.3 71.4 L47.6 78.6 Z" />
</g>
`.trim();

/**
 * Registers the mark under {@link BASALT_ICON_ID}. Call once from `onload()` — before anything
 * references the id, or the ribbon renders an empty box.
 */
export function registerBasaltIcon(): void {
  addIcon(BASALT_ICON_ID, BASALT_ICON_SVG);
}
