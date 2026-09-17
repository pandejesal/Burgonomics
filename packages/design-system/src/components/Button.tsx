/**
 * @burgonomics/design-system - Button Component
 * 
 * Unified button component using design tokens
 */

import React, { forwardRef, ButtonHTMLAttributes } from 'react';
import { cssVar, flexCenter } from '../utils';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'success';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  fullWidth?: boolean;
}

const baseStyles: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--spacing-sm)',
  fontFamily: 'var(--font-sans)',
  fontWeight: 600,
  borderRadius: 'var(--radius-lg)',
  transition: 'all 200ms var(--ease-out-quad)',
  cursor: 'pointer',
  border: 'none',
  outline: 'none',
  textDecoration: 'none',
  whiteSpace: 'nowrap',
  userSelect: 'none',
  touchAction: 'manipulation',
  '-webkit-tap-highlight-color': 'transparent',
};

const sizeStyles: Record<string, React.CSSProperties> = {
  sm: {
    padding: 'var(--spacing-xs) var(--spacing-md)',
    fontSize: 'var(--font-size-sm)',
    lineHeight: '1.4',
    minHeight: '36px',
    minWidth: '36px',
  },
  md: {
    padding: 'var(--spacing-sm) var(--spacing-lg)',
    fontSize: 'var(--font-size-base)',
    lineHeight: '1.5',
    minHeight: '44px',
    minWidth: '44px',
  },
  lg: {
    padding: 'var(--spacing-md) var(--spacing-xl)',
    fontSize: 'var(--font-size-lg)',
    lineHeight: '1.5',
    minHeight: '52px',
    minWidth: '52px',
  },
  xl: {
    padding: 'var(--spacing-lg) var(--spacing-xxl)',
    fontSize: 'var(--font-size-xl)',
    lineHeight: '1.5',
    minHeight: '60px',
    minWidth: '60px',
  },
};

const variantStyles: Record<string, React.CSSProperties> = {
  primary: {
    backgroundColor: 'var(--color-primary)',
    color: 'var(--color-primary-foreground)',
    border: 'none',
  },
  secondary: {
    backgroundColor: 'var(--color-secondary)',
    color: 'var(--color-secondary-foreground)',
    border: '1px solid var(--color-border)',
  },
  outline: {
    backgroundColor: 'transparent',
    color: 'var(--color-primary)',
    border: '2px solid var(--color-primary)',
  },
  ghost: {
    backgroundColor: 'transparent',
    color: 'var(--color-primary)',
    border: 'none',
  },
  destructive: {
    backgroundColor: 'var(--color-error)',
    color: 'var(--color-error-foreground)',
    border: 'none',
  },
  success: {
    backgroundColor: 'var(--color-success)',
    color: 'var(--color-success-foreground)',
    border: 'none',
  },
};

const hoverStyles: Record<string, React.CSSProperties> = {
  primary: {
    backgroundColor: 'var(--color-primary-hover)',
  },
  secondary: {
    backgroundColor: 'var(--color-surface-hover)',
  },
  outline: {
    backgroundColor: 'var(--color-primary)',
    color: 'var(--color-primary-foreground)',
  },
  ghost: {
    backgroundColor: 'var(--color-bg-secondary)',
  },
  destructive: {
    backgroundColor: 'var(--color-error)',
    opacity: 0.9,
  },
  success: {
    backgroundColor: 'var(--color-success)',
    opacity: 0.9,
  },
};

const activeStyles: Record<string, React.CSSProperties> = {
  primary: {
    backgroundColor: 'var(--color-primary-dark)',
  },
  secondary: {
    backgroundColor: 'var(--color-surface-hover)',
  },
  outline: {
    backgroundColor: 'var(--color-primary-dark)',
    color: 'var(--color-primary-foreground)',
  },
  ghost: {
    backgroundColor: 'var(--color-bg-secondary)',
  },
  destructive: {
    backgroundColor: 'var(--color-error)',
    opacity: 0.8,
  },
  success: {
    backgroundColor: 'var(--color-success)',
    opacity: 0.8,
  },
};

const disabledStyles: React.CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed',
  pointerEvents: 'none',
};

const loadingStyles: React.CSSProperties = {
  position: 'relative',
  color: 'transparent',
  pointerEvents: 'none',
};

const spinnerStyles: React.CSSProperties = {
  position: 'absolute',
  width: '1em',
  height: '1em',
  border: '2px solid currentColor',
  borderRightColor: 'transparent',
  borderRadius: '50%',
  animation: 'spin 0.6s linear infinite',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'primary',
      size = 'md',
      loading = false,
      icon,
      iconPosition = 'left',
      fullWidth = false,
      disabled,
      children,
      style,
      className,
      onClick,
      ...props
    },
    ref
  ) => {
    const isDisabled = disabled || loading;
    const sizeStyle = sizeStyles[size] || sizeStyles.md;
    const variantStyle = variantStyles[variant] || variantStyles.primary;
    const hoverStyle = hoverStyles[variant] || hoverStyles.primary;
    const activeStyle = activeStyles[variant] || activeStyles.primary;

    const styles: React.CSSProperties = {
      ...baseStyles,
      ...sizeStyle,
      ...variantStyle,
      ...(fullWidth ? { width: '100%' } : {}),
      ...(isDisabled ? disabledStyles : {}),
      ...(loading ? loadingStyles : {}),
      ...style,
    };

    const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
      if (isDisabled) {
        e.preventDefault();
        return;
      }
      onClick?.(e);
    };

    return (
      <button
        ref={ref}
        type="button"
        disabled={isDisabled}
        onClick={handleClick}
        style={styles}
        className={className}
        aria-disabled={isDisabled}
        aria-busy={loading}
        {...props}
      >
        {loading && (
          <span
            style={spinnerStyles}
            color="currentColor"
            aria-hidden="true"
          />
        )}
        {!loading && icon && iconPosition === 'left' && (
          <span style={{ display: 'flex', alignItems: 'center' }}>{icon}</span>
        )}
        <span style={{ display: loading ? 'none' : 'inline' }}>
          {children}
        </span>
        {!loading && icon && iconPosition === 'right' && (
          <span style={{ display: 'flex', alignItems: 'center' }}>{icon}</span>
        )}
        <style jsx>{`
          @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          button:hover:not(:disabled):not([aria-busy="true"]) {
            background-color: ${getComputedStyle(document.documentElement).getPropertyValue('--color-primary-hover') || '#0A371C'};
          }
          button:active:not(:disabled) {
            background-color: ${getComputedStyle(document.documentElement).getPropertyValue('--color-primary-dark') || '#082915'};
          }
        `}
      </button>
    );
  }
);

Button.displayName = 'Button';

export default Button;