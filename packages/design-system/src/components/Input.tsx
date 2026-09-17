/**
 * @burgonomics/design-system - Input Component
 * 
 * Unified input component using design tokens
 */

import React, { forwardRef, InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  fullWidth?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      hint,
      leftIcon,
      rightIcon,
      fullWidth = false,
      className,
      style,
      id,
      ...props
    },
    ref
  ) => {
    const inputId = id || `input-${Math.random().toString(36).slice(2, 9)}`;
    const errorId = error ? `${inputId}-error` : undefined;
    const hintId = hint ? `${inputId}-hint` : undefined;

    const styles: React.CSSProperties = {
      display: 'inline-flex',
      flexDirection: 'column',
      gap: 'var(--spacing-xs)',
      width: fullWidth ? '100%' : 'auto',
    };

    const labelStyles: React.CSSProperties = {
      fontSize: 'var(--font-size-sm)',
      fontWeight: 500,
      color: 'var(--color-text-primary)',
      marginBottom: 'var(--spacing-xxs)',
    };

    const inputWrapperStyles: React.CSSProperties = {
      position: 'relative',
      display: 'flex',
      alignItems: 'center',
    };

    const inputStyles: React.CSSProperties = {
      width: '100%',
      padding: 'var(--spacing-sm) var(--spacing-md)',
      fontSize: 'var(--font-size-base)',
      lineHeight: '1.5',
      fontFamily: 'var(--font-sans)',
      color: 'var(--color-text-primary)',
      backgroundColor: 'var(--color-input)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      outline: 'none',
      transition: 'all 200ms var(--ease-out-quad)',
      backgroundColor: 'var(--color-input)',
      '&:hover:not(:disabled)': {
        borderColor: 'var(--color-primary)',
      },
      '&:focus': {
        outline: 'none',
        borderColor: 'var(--color-ring)',
        boxShadow: '0 0 0 3px color-mix(in srgb, var(--color-ring) 20%, transparent)',
      },
      '&:disabled': {
        opacity: 0.5,
        cursor: 'not-allowed',
      },
      '&::placeholder': {
        color: 'var(--color-text-disabled)',
      },
      '&:invalid:not(:placeholder-shown)': {
        borderColor: 'var(--color-error)',
      },
    };

    const iconStyles: React.CSSProperties = {
      position: 'absolute',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--color-text-secondary)',
      pointerEvents: 'none',
    };

    const errorStyles: React.CSSProperties = {
      fontSize: 'var(--font-size-sm)',
      color: 'var(--color-error)',
      marginTop: 'var(--spacing-xxs)',
    };

    const hintStyles: React.CSSProperties = {
      fontSize: 'var(--font-size-sm)',
      color: 'var(--color-text-secondary)',
      marginTop: 'var(--spacing-xxs)',
    };

    return (
      <div style={styles} className={className}>
        {label && (
          <label htmlFor={inputId} style={labelStyles}>
            {label}
            {props.required && <span style={{ color: 'var(--color-error)', marginLeft: '4px' }}>*</span>}
          </label>
        )}
        <div style={inputWrapperStyles}>
          {leftIcon && (
            <span style={{ ...iconStyles, left: 'var(--spacing-md)' }} aria-hidden="true">
              {leftIcon}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            aria-invalid={!!error}
            aria-describedby={`${errorId ? errorId : ''} ${hintId ? hintId : ''}`.trim() || undefined}
            style={{
              ...inputStyles,
              paddingLeft: leftIcon ? 'var(--spacing-xl)' : 'var(--spacing-md)',
              paddingRight: rightIcon ? 'var(--spacing-xl)' : 'var(--spacing-md)',
            }}
            {...props}
          />
          {rightIcon && (
            <span style={{ ...iconStyles, right: 'var(--spacing-md)' }} aria-hidden="true">
              {rightIcon}
            </span>
          )}
        </div>
        {error && (
          <p id={errorId} style={errorStyles} role="alert">
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={hintId} style={hintStyles}>
            {hint}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
  fullWidth?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      label,
      error,
      hint,
      fullWidth = false,
      className,
      style,
      id,
      ...props
    },
    ref
  ) => {
    const inputId = id || `textarea-${Math.random().toString(36).slice(2, 9)}`;
    const errorId = error ? `${inputId}-error` : undefined;
    const hintId = hint ? `${inputId}-hint` : undefined;

    const styles: React.CSSProperties = {
      display: 'inline-flex',
      flexDirection: 'column',
      gap: 'var(--spacing-xs)',
      width: fullWidth ? '100%' : 'auto',
    };

    const labelStyles: React.CSSProperties = {
      fontSize: 'var(--font-size-sm)',
      fontWeight: 500,
      color: 'var(--color-text-primary)',
      marginBottom: 'var(--spacing-xxs)',
    };

    const textareaStyles: React.CSSProperties = {
      width: '100%',
      minHeight: '100px',
      padding: 'var(--spacing-sm) var(--spacing-md)',
      fontSize: 'var(--font-size-base)',
      lineHeight: '1.5',
      fontFamily: 'var(--font-sans)',
      color: 'var(--color-text-primary)',
      backgroundColor: 'var(--color-input)',
      border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg)',
      outline: 'none',
      resize: 'vertical',
      transition: 'all 200ms var(--ease-out-quad)',
      '&:hover:not(:disabled)': {
        borderColor: 'var(--color-primary)',
      },
      '&:focus': {
        outline: 'none',
        borderColor: 'var(--color-ring)',
        boxShadow: '0 0 0 3px color-mix(in srgb, var(--color-ring) 20%, transparent)',
      },
      '&:disabled': {
        opacity: 0.5,
        cursor: 'not-allowed',
      },
      '&::placeholder': {
        color: 'var(--color-text-disabled)',
      },
    };

    const errorStyles: React.CSSProperties = {
      fontSize: 'var(--font-size-sm)',
      color: 'var(--color-error)',
      marginTop: 'var(--spacing-xxs)',
    };

    const hintStyles: React.CSSProperties = {
      fontSize: 'var(--font-size-sm)',
      color: 'var(--color-text-secondary)',
      marginTop: 'var(--spacing-xxs)',
    };

    return (
      <div style={styles} className={className}>
        {label && (
          <label htmlFor={inputId} style={labelStyles}>
            {label}
            {props.required && <span style={{ color: 'var(--color-error)', marginLeft: '4px' }}>*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          aria-invalid={!!error}
          aria-describedby={`${error ? errorId : ''} ${hint ? hintId : ''}`.trim() || undefined}
          style={textareaStyles}
          {...props}
        />
        {error && (
          <p id={errorId} style={errorStyles} role="alert">
            {error}
          </p>
        )}
        {hint && !error && (
          <p id={hintId} style={hintStyles}>
            {hint}
          </p>
        )}
      </div>
    );
  }
);

Textarea.displayName = 'Textarea';

export { Input, Textarea };