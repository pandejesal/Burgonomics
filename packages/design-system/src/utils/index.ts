/**
 * @burgonomics/design-system - Utilities
 * 
 * Shared utilities that work with design tokens
 */

import type { ColorTokens, SemanticColors } from './tokens';

/**
 * Get color value from design tokens with fallback
 */
export function getColorToken(
  tokens: ColorTokens,
  path: string,
  fallback = 'transparent'
): string {
  const keys = path.split('.');
  let value: any = tokens;
  
  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return fallback;
    }
  }
  
  return typeof value === 'string' ? value : fallback;
}

/**
 * Get semantic color with fallback
 */
export function getSemanticColor(
  colors: SemanticColors,
  category: keyof typeof colors.light,
  key: string,
  fallback = 'transparent'
): string {
  const categoryColors = colors[category as keyof typeof colors.light];
  if (!categoryColors || typeof categoryColors !== 'object') {
    return fallback;
  }
  
  const value = (categoryColors as Record<string, string>)[key];
  return value || fallback;
}

/**
 * Generate CSS custom properties from design tokens
 */
export function generateCSSVariables(tokens: typeof import('./tokens').designTokens): string {
  const lines: string[] = [];
  
  // Colors
  for (const [mode, colors] of Object.entries(tokens.colors)) {
    const prefix = mode === 'light' ? '' : '.dark ';
    for (const [key, value] of Object.entries(colors)) {
      lines.push(`${prefix}--color-${kebabCase(key)}: ${value};`);
    }
  }
  
  // Spacing
  for (const [key, value] of Object.entries(tokens.spacing)) {
    lines.push(`--spacing-${kebabCase(key)}: ${value};`);
  }
  
  // Border radius
  for (const [key, value] of Object.entries(tokens.radii)) {
    lines.push(`--radius-${kebabCase(key)}: ${value};`);
  }
  
  // Shadows
  for (const [key, value] of Object.entries(tokens.shadows)) {
    lines.push(`--shadow-${kebabCase(key)}: ${value};`);
  }
  
  // Z-indices
  for (const [key, value] of Object.entries(tokens.zIndices)) {
    lines.push(`--z-${kebabCase(key)}: ${value};`);
  }
  
  // Transitions
  for (const [key, value] of Object.entries(tokens.transitions)) {
    lines.push(`--transition-${kebabCase(key)}: ${value};`);
  }
  
  // Border radius
  for (const [key, value] of Object.entries(tokens.radii)) {
    lines.push(`--radius-${kebabCase(key)}: ${value};`);
  }
  
  return lines.join('\n');
}

function kebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Get CSS variable reference
 */
export function cssVar(name: string): string {
  return `var(--${name})`;
}

/**
 * Create a themed style object
 */
export function createThemedStyles(
  lightStyles: Record<string, string>,
  darkStyles: Record<string, string>
): Record<string, string> {
  const styles: Record<string, string> = { ...lightStyles };
  
  for (const [key, value] of Object.entries(darkStyles)) {
    styles[`.dark ${key}`] = value;
  }
  
  return styles;
}

/**
 * Create responsive styles
 */
export function createResponsiveStyles(
  styles: Record<string, Record<string, string>>
): Record<string, string> {
  const result: Record<string, string> = {};
  
  for (const [breakpoint, styles] of Object.entries(styles)) {
    if (breakpoint === 'base') {
      Object.assign(result, styles);
    } else {
      const mediaQuery = `@media (min-width: ${breakpoint})`;
      for (const [selector, styles] of Object.entries(styles)) {
        result[`${mediaQuery} ${selector}`] = styles;
      }
    }
  }
  
  return result;
}

/**
 * Create focus-visible styles
 */
export function createFocusStyles(
  ringColor = 'var(--focus-ring)',
  offset = '2px'
): Record<string, string> {
  return {
    '&:focus-visible': {
      outline: `2px solid ${cssVar('focus-ring')}`,
      outlineOffset: '2px',
    },
  };
}

/**
 * Create visually hidden utility
 */
export const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: '0',
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: '0',
} as const;

/**
 * Create container styles
 */
export function createContainerStyles(
  maxWidth = '1280px',
  padding = 'var(--spacing-md)'
): Record<string, string> {
  return {
    width: '100%',
    maxWidth,
    margin: '0 auto',
    padding,
    boxSizing: 'border-box',
  };
}

/**
 * Create flex center utility
 */
export const flexCenter = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
} as const;

/**
 * Create flex between utility
 */
export const flexBetween = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
} as const;

/**
 * Create flex column utility
 */
export const flexColumn = {
  display: 'flex',
  flexDirection: 'column',
} as const;

/**
 * Create truncate utility
 */
export const truncate = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

/**
 * Create visually hidden utility
 */
export const srOnly = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: '0',
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: '0',
} as const;