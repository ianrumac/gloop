import React from 'react';
import { cn } from '../lib/utils';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'ghost' | 'accent';
  size?: 'default' | 'sm' | 'lg';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => {
    return (
      <button
        className={cn(
          'inline-flex items-center justify-center font-mono text-xs uppercase tracking-widest transition-all duration-300 ease-out font-semibold',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
          'disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
          {
            'bg-foreground text-background hover:bg-accent hover:text-accent-foreground': variant === 'default',
            'border border-foreground bg-transparent hover:bg-foreground hover:text-background': variant === 'outline',
            'hover:bg-muted': variant === 'ghost',
            'bg-accent text-white hover:bg-foreground hover:text-background': variant === 'accent',
            'h-12 px-6': size === 'default',
            'h-8 px-4 text-[10px]': size === 'sm',
            'h-14 px-10 text-sm': size === 'lg',
          },
          className
        )}
        ref={ref}
        {...props}
      >
        {props.children}
      </button>
    );
  }
);

Button.displayName = 'Button';
