/**
 * @burgonomics/design-system - Card Component
 * 
 * Unified card component using design tokens
 */

import React, { ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  variant?: 'default' | 'elevated' | 'outlined' | 'ghost';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  hoverable?: boolean;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

const variantStyles: Record<string, React.CSSProperties> = {
  default: {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
  },
  elevated: {
    backgroundColor: 'var(--color-surface-elevated)',
    border: 'none',
    boxShadow: 'var(--shadow-md)',
  },
  outlined: {
    backgroundColor: 'transparent',
    border: '2px solid var(--color-border)',
  },
  ghost: {
    backgroundColor: 'transparent',
    border: 'none',
  },
};

const paddingStyles: Record<string, React.CSSProperties> = {
  none: { padding: 0 },
  sm: { padding: 'var(--spacing-sm)' },
  md: { padding: 'var(--spacing-md)' },
  lg: { padding: 'var(--spacing-lg)' },
};

const baseStyles: React.CSSProperties = {
  borderRadius: 'var(--radius-xl)',
  transition: 'all 200ms var(--ease-out-quad)',
  overflow: 'hidden',
};

const hoverStyles: React.CSSProperties = {
  transform: 'translateY(-2px)',
  boxShadow: 'var(--shadow-lg)',
};

const activeStyles: React.CSSProperties = {
  transform: 'translateY(0) scale(0.98)',
};

export interface CardProps {
  children: React.ReactNode;
  variant?: 'default' | 'elevated' | 'outlined' | 'ghost';
  padding?: 'none' | 'sm' | 'md' | 'lg';
  hoverable?: boolean;
  onClick?: () => void;
  className?: string;
  style?: React.CSSProperties;
}

export const Card = React.forwardRef<HTMLDivElement, CardProps>(
  (
    {
      children,
      variant = 'default',
      padding = 'md',
      hoverable = false,
      onClick,
      className,
      style,
    },
    ref
  ) => {
    const variantStyle = variantStyles[variant] || variantStyles.default;
    const paddingStyle = paddingStyles[padding] || paddingStyles.md;

    const styles: React.CSSProperties = {
      ...baseStyles,
      ...variantStyle,
      ...paddingStyle,
      ...style,
    };

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
      onClick?.(e);
    };

    return (
      <div
        ref={ref}
        style={{
          ...baseStyles,
          ...variantStyles[variant] || variantStyles.default,
          ...paddingStyles[padding] || paddingStyles.md,
          ...style,
        }}
        onClick={onClick}
        className={className}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>);
          }
        }}
        role={onClick ? 'button' : undefined}
        aria-pressed={onClick ? false : undefined}
      >
        {children}
      </div>
    );
  }
);

Card.displayName = 'Card';

export interface CardHeaderProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const CardHeader = React.forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ children, className, style }, ref) => (
    <div
      ref={ref}
      className={className}
      style={{
        padding: 'var(--spacing-md) var(--spacing-md) var(--spacing-sm)',
        borderBottom: '1px solid var(--color-border)',
        ...style,
      }}
    >
      {children}
    </div>
  )
);

CardHeader.displayName = 'CardHeader';

export interface CardContentProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const CardContent = React.forwardRef<HTMLDivElement, CardContentProps>(
  ({ children, className, style }, ref) => (
    <div
      ref={ref}
      className={className}
      style={{
        padding: 'var(--spacing-md)',
        ...style,
      }}
    >
      {children}
    </div>
  )
);

CardContent.displayName = 'CardContent';

export interface CardFooterProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export const CardFooter = React.forwardRef<HTMLDivElement, CardFooterProps>(
  ({ children, className, style }, ref) => (
    <div
      ref={ref}
      className={className}
      style={{
        padding: 'var(--spacing-sm) var(--spacing-md) var(--spacing-md)',
        borderTop: '1px solid var(--color-divider)',
        ...style,
      }}
    >
      {children}
    </div>
  )
);

CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardContent, CardFooter };