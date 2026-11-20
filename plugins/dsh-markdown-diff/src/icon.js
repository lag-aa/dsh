/**
 * The section's navigation icon.
 *
 * Settings rows keep the shell's default glyph until a section registers one, and
 * the default says nothing about what the section changes. This one is a split
 * frame with a minus on the left and a plus on the right — the two marks the
 * preview itself paints, in the shape of a diff — so the row reads as "what
 * changed in this file" rather than as a generic page.
 *
 * It draws in `currentColor` with no fill, so the shell's own colours do their
 * work: the glyph follows hover, selection and the light or dark theme without a
 * second palette to keep in step.
 *
 * @module dsh-markdown-diff/icon
 */

/**
 * The section icon.
 * @param props - `{ size }`, the square edge the shell asks for.
 * @returns the icon.
 */
export function MarkdownDiffIcon({ size = 16 }) {
  return React.createElement('svg', {
    // 24 is the drawing grid; the shell's requested edge scales it down.
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    'data-markdown-diff-icon': 'true',
  },
  React.createElement('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3.5 }),
  // The split: two halves compared, as in a side-by-side diff.
  React.createElement('path', { d: 'M12 5.8v12.4' }),
  React.createElement('path', { d: 'M5.9 12h3.5' }),
  React.createElement('path', { d: 'M14.6 12h3.5' }),
  React.createElement('path', { d: 'M16.35 10.25v3.5' }));
}
