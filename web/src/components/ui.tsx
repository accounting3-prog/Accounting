/**
 * Shared primitives.
 *
 * Deliberately small and plain: hairline borders, small radii, no shadows
 * except a single lift on overlays, no decorative colour. Colour is reserved
 * for meaning — negative, positive, or needing review.
 */

import type { ReactNode } from 'react';
import { formatAmount } from '../lib/format';

/* ------------------------------------------------------------------ money */

/**
 * An amount, always with its currency, always tabular so columns align.
 *
 * `tone="ledger"` colours by sign, which is right for a signed effect on a
 * balance. `tone="plain"` leaves it in ink, which is right for a balance
 * itself — a balance is not "bad" for being large.
 */
export function Money({
  amount,
  currency = 'AED',
  signed = false,
  tone = 'plain',
  code = true,
  className = '',
}: {
  amount: number | null | undefined;
  currency?: string;
  signed?: boolean;
  tone?: 'plain' | 'ledger' | 'muted';
  code?: boolean;
  className?: string;
}) {
  const value = amount ?? null;
  let colour = 'text-ink';
  if (tone === 'muted') colour = 'text-ink-muted';
  if (tone === 'ledger' && value !== null) {
    colour = value < 0 ? 'text-negative' : value > 0 ? 'text-positive' : 'text-ink-muted';
  }
  return (
    <span className={`tnum whitespace-nowrap ${colour} ${className}`}>
      {formatAmount(value, currency, signed)}
      {code && value !== null && (
        <span className="ml-1 text-[0.85em] text-ink-faint">{currency}</span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ status */

const STATUS_STYLE: Record<string, string> = {
  confirmed: 'bg-sunken text-ink-muted border-line',
  needs_review: 'bg-review-soft text-review border-[#e8d5ab]',
  excluded_from_source_balance: 'bg-negative-soft text-negative border-[#eecac6]',
  voided: 'bg-sunken text-ink-faint border-line line-through',
};

const STATUS_LABEL: Record<string, string> = {
  confirmed: 'Confirmed',
  needs_review: 'Needs review',
  excluded_from_source_balance: 'Excluded from source',
  voided: 'Voided',
};

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-[11px] leading-4 font-medium ${
        STATUS_STYLE[status] ?? STATUS_STYLE.confirmed
      }`}
    >
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Tag({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'review' | 'negative' | 'accent';
}) {
  const styles = {
    neutral: 'bg-sunken text-ink-muted border-line',
    review: 'bg-review-soft text-review border-[#e8d5ab]',
    negative: 'bg-negative-soft text-negative border-[#eecac6]',
    accent: 'bg-accent-soft text-accent border-[#cddcea]',
  }[tone];
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-[11px] leading-4 font-medium ${styles}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ layout */

export function Panel({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-md border border-line bg-surface ${className}`}
    >
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[13px] font-semibold tracking-tight text-ink">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
            )}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** A single figure. Label above, value below — scannable in a row of them. */
export function Stat({
  label,
  value,
  hint,
  tone = 'plain',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'plain' | 'review' | 'negative';
}) {
  const valueColour =
    tone === 'review' ? 'text-review' : tone === 'negative' ? 'text-negative' : 'text-ink';
  return (
    <div className="min-w-0 rounded-md border border-line bg-surface px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
        {label}
      </div>
      <div className={`mt-1.5 text-xl font-semibold tracking-tight ${valueColour}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ states */

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-12 text-sm text-ink-muted">
      <span
        aria-hidden
        className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line-strong border-t-accent"
      />
      {label}…
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-4 py-14 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && (
        <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Could not load this view',
  detail,
  onRetry,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="m-4 rounded-md border border-[#eecac6] bg-negative-soft px-4 py-4">
      <p className="text-sm font-semibold text-negative">{title}</p>
      {detail && <p className="mt-1 text-sm text-ink-muted">{detail}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-sm border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-ink hover:bg-sunken"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/** A warning that names a specific, known discrepancy. */
export function Notice({
  tone = 'review',
  title,
  children,
}: {
  tone?: 'review' | 'negative' | 'accent';
  title: ReactNode;
  children?: ReactNode;
}) {
  const styles = {
    review: 'border-[#e8d5ab] bg-review-soft',
    negative: 'border-[#eecac6] bg-negative-soft',
    accent: 'border-[#cddcea] bg-accent-soft',
  }[tone];
  const titleColour = {
    review: 'text-review',
    negative: 'text-negative',
    accent: 'text-accent',
  }[tone];
  return (
    <div className={`rounded-md border px-3.5 py-3 ${styles}`}>
      <p className={`text-[13px] font-semibold ${titleColour}`}>{title}</p>
      {children && <div className="mt-1 text-[13px] text-ink">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ inputs */

export const fieldClass =
  'w-full rounded-sm border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink ' +
  'placeholder:text-ink-faint focus:border-accent focus:outline-none ' +
  'disabled:bg-sunken disabled:text-ink-faint';

export const labelClass =
  'block text-[11px] font-medium uppercase tracking-wide text-ink-faint';

export function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className={labelClass}>
        {label}
        {required && <span className="ml-0.5 text-negative">*</span>}
      </span>
      <div className="mt-1">{children}</div>
      {error ? (
        <p className="mt-1 text-xs text-negative">{error}</p>
      ) : (
        hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>
      )}
    </label>
  );
}

export function Button({
  variant = 'secondary',
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
}) {
  const styles = {
    primary:
      'bg-accent text-white border-accent hover:bg-[#1a3f63] disabled:bg-[#9fb3c6] disabled:border-[#9fb3c6]',
    secondary:
      'bg-surface text-ink border-line-strong hover:bg-sunken disabled:text-ink-faint',
    ghost:
      'bg-transparent text-ink-muted border-transparent hover:bg-sunken hover:text-ink',
    danger:
      'bg-surface text-negative border-[#eecac6] hover:bg-negative-soft',
  }[variant];
  return (
    <button
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-sm border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:cursor-not-allowed ${styles} ${
        props.className ?? ''
      }`}
    >
      {children}
    </button>
  );
}
