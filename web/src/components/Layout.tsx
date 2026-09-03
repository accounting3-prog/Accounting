import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { getTotals } from '../lib/ledger';
import { useDataSourceLabel, useLedgerState } from './LedgerProvider';

const NAV = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/transactions', label: 'Transactions' },
  { to: '/review', label: 'Review queue', badge: true },
  { to: '/cards', label: 'Cards' },
  { to: '/add', label: 'Add transaction' },
];

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const totals = getTotals();
  const openReviews = totals.needsReview + totals.excluded;

  return (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center justify-between rounded-sm px-2.5 py-1.5 text-[13px] transition-colors ${
              isActive
                ? 'bg-accent-soft font-semibold text-accent'
                : 'text-ink-muted hover:bg-sunken hover:text-ink'
            }`
          }
        >
          <span>{item.label}</span>
          {item.badge && openReviews > 0 && (
            <span className="tnum rounded-sm bg-review-soft px-1.5 text-[11px] font-semibold text-review">
              {openReviews}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function SourceBadge() {
  const { label, live } = useDataSourceLabel();
  const { reload } = useLedgerState();
  return (
    <div className="border-t border-line px-3 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-ink-faint">
        Data source
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[13px] text-ink">
        <span
          aria-hidden
          className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-positive' : 'bg-review'}`}
        />
        {label}
      </div>
      {!live && (
        <p className="mt-1 text-[11px] leading-snug text-ink-muted">
          Figures are the audited workbook extraction, not live data.
        </p>
      )}
      <button
        type="button"
        onClick={reload}
        className="mt-1.5 text-[11px] text-accent hover:underline underline-offset-2"
      >
        Refresh
      </button>
    </div>
  );
}

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  return (
    <div className="min-h-screen lg:flex">
      {/* Mobile header */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface px-4 py-2.5 lg:hidden">
        <div>
          <div className="text-[13px] font-semibold tracking-tight">Card Ledger</div>
          <div className="text-[11px] text-ink-muted">
            {NAV.find((n) => n.to === location.pathname)?.label ?? ''}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-label="Toggle navigation"
          className="rounded-sm border border-line-strong px-2.5 py-1 text-[13px] text-ink"
        >
          Menu
        </button>
      </header>

      {menuOpen && (
        <div className="border-b border-line bg-surface px-3 py-3 lg:hidden">
          <NavItems onNavigate={() => setMenuOpen(false)} />
          <SourceBadge />
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="px-4 py-4">
          <div className="text-[13px] font-semibold tracking-tight text-ink">
            Card Ledger
          </div>
          <div className="text-[11px] text-ink-muted">Multi-currency reconciliation</div>
        </div>
        <div className="px-2.5">
          <NavItems />
        </div>
        <div className="mt-auto">
          <SourceBadge />
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

/** Standard page frame: title, optional description, content. */
export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6 lg:px-8 lg:py-7">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
          {description && (
            <div className="mt-1 max-w-2xl text-[13px] text-ink-muted">{description}</div>
          )}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}
