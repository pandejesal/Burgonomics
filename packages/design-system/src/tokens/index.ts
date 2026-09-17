/**
 * @burgonomics/design-system - Unified Design Tokens
 * 
 * Single source of truth for all design tokens across Burgonomics apps.
 * Both customer app (foundation-core) and partner app must use these tokens.
 * 
 * Palette: 60-30-10 (Canvas 60%, Brand 30%, Accent 10%)
 * Light: Canvas #F5F5F5, Brand #0E4825, Accent #FF6600
 * Dark: Canvas #0A0A0A, Brand #0E4825, Accent #CC5200
 */

// ============================================================================
// COLOR TOKENS
// ============================================================================

export const colors = {
  // Light mode (default)
  light: {
    // 60% Canvas
    background: '#F5F5F5',
    foreground: '#16281D',
    surface: '#FFFFFF',
    surfaceElevated: '#FFFFFF',
    bgSecondary: '#F0F3F1',
    
    // 30% Brand (Forest Green)
    primary: '#0E4825',
    primaryHover: '#0A371C',
    primaryLight: '#145830',
    primaryDark: '#082915',
    primaryForeground: '#FFFFFF',
    primaryText: '#0E4825',
    
    // 10% Accent (Vibrant Orange)
    accent: '#FF6600',
    accentHover: '#CC5200',
    accentLight: '#FF802B',
    accentForeground: '#FFFFFF',
    
    // Semantic
    secondary: '#FFFFFF',
    secondaryForeground: '#0E4825',
    muted: '#F0F3F1',
    mutedForeground: '#586B60',
    
    // Status
    success: '#16A34A',
    successForeground: '#FFFFFF',
    warning: '#F59E0B',
    warningForeground: '#0A0A0A',
    error: '#DC2626',
    errorForeground: '#FFFFFF',
    destructive: '#DC2626',
    destructiveForeground: '#FFFFFF',
    
    // UI
    border: '#E5EDE7',
    divider: '#E5EDE7',
    input: '#F0F3F1',
    ring: '#FF6600',
    focusRing: '#FF6600',
    
    // Veg/Non-veg indicators
    veg: '#16A34A',
    nonveg: '#DC2626',
    
    // Chart colors
    chart1: '#0E4825',
    chart2: '#FF6600',
    chart3: '#16A34A',
    chart4: '#F59E0B',
    chart5: '#586B60',
    
    // Sidebar
    sidebar: '#0E4825',
    sidebarForeground: '#FFFFFF',
    sidebarPrimary: '#FF6600',
    sidebarPrimaryForeground: '#FFFFFF',
    sidebarAccent: '#175E33',
    sidebarAccentForeground: '#FFFFFF',
    sidebarBorder: '#1B5934',
    sidebarRing: '#FF6600',
  },
  
  // Dark mode
  dark: {
    // 60% Canvas
    background: '#0A0A0A',
    foreground: '#F3F5F4',
    surface: '#1A1A1A',
    surfaceElevated: '#222222',
    bgSecondary: '#141414',
    
    // 30% Brand
    primary: '#0E4825',
    primaryHover: '#145830',
    primaryLight: '#1A6B3A',
    primaryDark: '#082915',
    primaryForeground: '#FFFFFF',
    primaryText: '#4ADE80',
    
    // 10% Accent
    accent: '#CC5200',
    accentHover: '#B34700',
    accentLight: '#FF802B',
    accentForeground: '#FFFFFF',
    
    // Semantic
    secondary: '#1A1A1A',
    secondaryForeground: '#F3F5F4',
    muted: '#141414',
    mutedForeground: '#A0A0A0',
    
    // Status
    success: '#22C55E',
    successForeground: '#FFFFFF',
    warning: '#FBBF24',
    warningForeground: '#0A0A0A',
    error: '#EF4444',
    errorForeground: '#FFFFFF',
    destructive: '#EF4444',
    destructiveForeground: '#FFFFFF',
    
    // UI
    border: '#262626',
    divider: '#262626',
    input: '#141414',
    ring: '#CC5200',
    focusRing: '#CC5200',
    
    // Veg/Non-veg
    veg: '#22C55E',
    nonveg: '#EF4444',
    
    // Chart
    chart1: '#0E4825',
    chart2: '#CC5200',
    chart3: '#22C55E',
    chart4: '#FBBF24',
    chart5: '#A0A0A0',
    
    // Sidebar
    sidebar: '#0E4825',
    sidebarForeground: '#FFFFFF',
    sidebarPrimary: '#CC5200',
    sidebarPrimaryForeground: '#FFFFFF',
    sidebarAccent: '#175E33',
    sidebarAccentForeground: '#FFFFFF',
    sidebarBorder: '#1B5934',
    sidebarRing: '#CC5200',
  },
} as const;

// ============================================================================
// SEMANTIC COLOR MAPS (for easy theming)
// ============================================================================

export const semanticColors = {
  light: {
    // Backgrounds
    bg: {
      primary: 'var(--background)',
      secondary: 'var(--bg-secondary)',
      surface: 'var(--surface)',
      elevated: 'var(--surface-elevated)',
    },
    // Text
    text: {
      primary: 'var(--text-primary)',
      secondary: 'var(--text-secondary)',
      inverse: 'var(--text-inverse)',
      disabled: 'var(--text-disabled)',
      onPrimary: 'var(--primary-foreground)',
      onAccent: 'var(--accent-foreground)',
      onError: 'var(--error-foreground)',
    },
    // Brand
    brand: {
      primary: 'var(--primary)',
      hover: 'var(--primary-hover)',
      light: 'var(--primary-light)',
      dark: 'var(--primary-dark)',
      foreground: 'var(--primary-foreground)',
      text: 'var(--primary-text)',
    },
    // Accent
    accent: {
      primary: 'var(--accent)',
      hover: 'var(--accent-hover)',
      light: 'var(--accent-light)',
      foreground: 'var(--accent-foreground)',
    },
    // Status
    status: {
      success: 'var(--success)',
      successFg: 'var(--success-foreground)',
      warning: 'var(--warning)',
      warningFg: 'var(--warning-foreground)',
      error: 'var(--error)',
      errorFg: 'var(--error-foreground)',
      warning: 'var(--warning)',
      warningFg: 'var(--warning-foreground)',
    },
    // UI
    ui: {
      border: 'var(--border)',
      divider: 'var(--divider)',
      input: 'var(--input)',
      ring: 'var(--ring)',
      focusRing: 'var(--focus-ring)',
      disabled: 'var(--disabled)',
    },
    // Veg/Non-veg
    dietary: {
      veg: 'var(--veg)',
      nonveg: 'var(--nonveg)',
    },
  },
  dark: {
    bg: {
      primary: 'var(--background)',
      secondary: 'var(--bg-secondary)',
      surface: 'var(--surface)',
      elevated: 'var(--surface-elevated)',
    },
    text: {
      primary: 'var(--text-primary)',
      secondary: 'var(--text-secondary)',
      inverse: 'var(--text-inverse)',
      disabled: 'var(--text-disabled)',
      onPrimary: 'var(--primary-foreground)',
      onAccent: 'var(--accent-foreground)',
      onError: 'var(--error-foreground)',
    },
    brand: {
      primary: 'var(--primary)',
      hover: 'var(--primary-hover)',
      light: 'var(--primary-light)',
      dark: 'var(--primary-dark)',
      foreground: 'var(--primary-foreground)',
      text: 'var(--primary-text)',
    },
    accent: {
      primary: 'var(--accent)',
      hover: 'var(--accent-hover)',
      light: 'var(--accent-light)',
      foreground: 'var(--accent-foreground)',
    },
    status: {
      success: 'var(--success)',
      successFg: 'var(--success-foreground)',
      warning: 'var(--warning)',
      warningFg: 'var(--warning-foreground)',
      error: 'var(--error)',
      errorFg: 'var(--error-foreground)',
    },
    ui: {
      border: 'var(--border)',
      divider: 'var(--divider)',
      input: 'var(--input)',
      ring: 'var(--ring)',
      focusRing: 'var(--focus-ring)',
      disabled: 'var(--disabled)',
    },
    dietary: {
      veg: 'var(--veg)',
      nonveg: 'var(--nonveg)',
    },
  },
} as const;

// ============================================================================
// SPACING TOKENS
// ============================================================================

export const spacing = {
  xxxs: '4px',
  xxs: '8px',
  xs: '12px',
  sm: '16px',
  md: '24px',
  lg: '32px',
  xl: '40px',
  xxl: '48px',
  xxxl: '64px',
} as const;

// ============================================================================
// BORDER RADIUS TOKENS
// ============================================================================

export const borderRadius = {
  none: '0',
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  xxl: '20px',
  full: '9999px',
} as const;

// ============================================================================
// TYPOGRAPHY TOKENS
// ============================================================================

export const typography = {
  fontFamilies: {
    sans: '"Montserrat", ui-sans-serif, system-ui, -apple-system, sans-serif',
    display: '"MonstroSolid", "Lilita One", "Montserrat", sans-serif',
    mono: '"JetBrains Mono", "Fira Code", monospace',
  },
  fontSizes: {
    xs: '12px',
    sm: '14px',
    base: '16px',
    lg: '18px',
    xl: '20px',
    '2xl': '24px',
    '3xl': '30px',
    '4xl': '36px',
    '5xl': '48px',
  },
  fontWeights: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extrabold: 800,
  },
  lineHeights: {
    tight: 1.2,
    normal: 1.5,
    relaxed: 1.75,
  },
  letterSpacing: {
    tight: '-0.02em',
    normal: '0',
    wide: '0.02em',
  },
} as const;

// ============================================================================
// BORDER RADIUS TOKENS
// ============================================================================

export const radii = {
  none: '0',
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  xxl: '20px',
  full: '9999px',
} as const;

// ============================================================================
// SHADOW/ELEVATION TOKENS
// ============================================================================

export const shadows = {
  flat: 'none',
  sm: '0 1px 2px 0 rgba(14, 72, 37, 0.05)',
  md: '0 4px 6px -1px rgba(14, 72, 37, 0.1), 0 2px 4px -1px rgba(14, 72, 37, 0.06)',
  lg: '0 10px 15px -3px rgba(14, 72, 37, 0.1), 0 4px 6px -2px rgba(14, 72, 37, 0.05)',
  xl: '0 20px 25px -5px rgba(14, 72, 37, 0.1), 0 10px 10px -5px rgba(14, 72, 37, 0.04)',
  '2xl': '0 25px 50px -12px rgba(14, 72, 37, 0.25)',
  brand: '0 16px 32px -8px rgba(194, 65, 12, 0.3)',
  inner: 'inset 0 2px 4px 0 rgba(14, 72, 37, 0.06)',
} as const;

// ============================================================================
// Z-INDEX TOKENS
// ============================================================================

export const zIndex = {
  hide: -1,
  base: 0,
  dropdown: 100,
  sticky: 200,
  fixed: 300,
  modalBackdrop: 400,
  modal: 500,
  popover: 600,
  tooltip: 700,
  toast: 800,
  max: 9999,
} as const;

// ============================================================================
// BREAKPOINT TOKENS
// ============================================================================

export const breakpoints = {
  xs: '320px',
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
} as const;

// ============================================================================
// TRANSITION/ANIMATION TOKENS
// ============================================================================

export const transitions = {
  fast: '150ms ease-out',
  normal: '200ms ease-out',
  slow: '300ms ease-out',
  slower: '500ms ease-out',
  easeOutQuad: 'cubic-bezier(0.25, 1, 0.5, 1)',
  easeOutQuint: 'cubic-bezier(0.16, 1, 0.3, 1)',
  easeOutBack: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

// ============================================================================
// Z-INDEX TOKENS
// ============================================================================

export const zIndices = {
  hide: -1,
  base: 0,
  dropdown: 100,
  sticky: 200,
  fixed: 300,
  modalBackdrop: 400,
  modal: 500,
  popover: 600,
  tooltip: 700,
  toast: 800,
  max: 9999,
} as const;

// ============================================================================
// BORDER RADIUS TOKENS
// ============================================================================

export const borderRadius = {
  none: '0',
  sm: '4px',
  md: '8px',
  lg: '12px',
  xl: '16px',
  xxl: '20px',
  full: '9999px',
} as const;

// ============================================================================
// EXPORTS
// ============================================================================

export type ColorTokens = typeof colors.light;
export type SemanticColors = typeof semanticColors.light;
export type SpacingTokens = typeof spacing;
export type TypographyTokens = typeof typography;
export type RadiiTokens = typeof radii;
export type ShadowTokens = typeof shadows;
export type ZIndexTokens = typeof zIndices;
export type BreakpointTokens = typeof breakpoints;
export type TransitionTokens = typeof transitions;
export type RadiusTokens = typeof radii;

export const designTokens = {
  colors,
  semanticColors,
  spacing,
  typography,
  radii,
  shadows,
  zIndices,
  breakpoints,
  transitions,
  radii: borderRadius,
} as const;

export default designTokens;