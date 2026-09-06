/**
 * Everything that has been done, and who did it.
 *
 * One feed rather than three screens, because the question people actually ask
 * is "what happened to this?" and the answer can be a transaction edit, a card
 * change or an access grant. Splitting those apart makes the reader reassemble
 * the sequence themselves.
 *
 * Two things this page is careful about:
 *
 *   - It never says a row was deleted, because nothing can be. There is no
 *     delete path in the database; a row that should not count is voided, and
 *     that is a status change and appears here.
 *   - Reading it needs an admin session. That is enforced in the database, not
 *     here, so this page shows what the database returns — including its
 *     refusal, in plain words.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Page } from '../components/Layout';
import {
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Money,
  Panel,
  Tag,
  fieldClass,
} from '../components/ui';
import { listActivity, type ActivityRow } from '../lib/api';

const AREA_LABEL: Record<string, string> = {
  transaction: 'Transaction',
  card: 'Card',
  access: 'Access',
};

/** What each action did, in the words someone reading a ledger would use. */
const ACTION_LABEL: Record<string, string> = {
  created: 'added',
  annotated: 'edited',
  status_changed: 'status changed',
  superseded: 'replaced',
  linked: 'linked',
  updated: 'changed',
  deactivated: 'deactivated',
  granted: 'given write access',
  revoked: 'write access removed',
};

const ACTION_TONE: Record<string, 'neutral' | 'accent' | 'review' | 'negative'> = {
  created: 'accent',
  annotated: 'review',
  status_changed: 'review',
  superseded: 'negative',
  revoked: 'negative',
  granted: 'accent',
};

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A changed field, shown as what it was and what it became. */
function Changes({ changes, action }: { changes: ActivityRow['changes']; action: string }) {
  if (!changes || typeof changes !== 'object') return null;
  const entries = Object.entries(changes as Record<string, unknown>);
  if (!entries.length) return null;

  // On a creation the payload is the row as entered, not a before/after pair.
  const isPair = (v: unknown): v is { from?: unknown; to?: unknown } =>
    typeof v === 'object' && v !== null && ('from' in v || 'to' in v);

  const show = (v: unknown) =>
    v === null || v === undefined || v === '' ? '—' : String(v);

  return (
    <dl className="mt-1.5 grid gap-x-4 gap-y-0.5 text-xs sm:grid-cols-2">
      {entries.map(([field, value]) => (
        <div key={field} className="flex flex-wrap items-baseline gap-1.5">
          <dt className="text-ink-faint">{field.replace(/_/g, ' ')}</dt>
          <dd className="tnum">
            {isPair(value) && action !== 'created' ? (
              <>
                <span className="text-ink-muted line-through">{show(value.from)}</span>
                <span className="mx-1 text-ink-faint">→</span>
                <span className="font-medium text-ink">{show(value.to)}</span>
              </>
            ) : (
              <span className="text-ink">{show(isPair(value) ? value.to : value)}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function History() {
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [area, setArea] = useState<'all' | 'transaction' | 'card' | 'access'>('all');
  const [actor, setActor] = useState('all');
  const [query, setQuery] = useState('');

  const load = () => {
    setRows(null);
    setError(null);
    listActivity().then((r) => (r.ok ? setRows(r.rows) : setError(r.error)));
  };
  useEffect(load, []);

  const actors = useMemo(
    () => [...new Set((rows ?? []).map((r) => r.actor))].sort(),
    [rows],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter(
      (r) =>
        (area === 'all' || r.area === area) &&
        (actor === 'all' || r.actor === actor) &&
        (!q ||
          `${r.subject} ${r.card_name ?? ''} ${r.rationale} ${r.actor} ${r.note ?? ''}`
            .toLowerCase()
            .includes(q)),
    );
  }, [rows, area, actor, query]);

  return (
    <Page
      title="History"
      description="Every change, who made it and why. Nothing in this ledger can be deleted — a row that should not count is voided, and that shows here as a status change."
      actions={<Button onClick={load}>Refresh</Button>}
    >
      {error ? (
        <ErrorState
          title={
            /42501|permission|admin/i.test(error)
              ? 'The history is limited to admins'
              : 'Could not load the history'
          }
          detail={
            /42501|permission|admin/i.test(error)
              ? 'Your account can read the ledger. Seeing who changed what needs an admin session.'
              : error
          }
          onRetry={load}
        />
      ) : rows === null ? (
        <LoadingState label="Reading the history" />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search the history…"
              className={`${fieldClass} max-w-xs`}
            />
            <select
              value={area}
              onChange={(e) => setArea(e.target.value as typeof area)}
              className={`${fieldClass} max-w-[10rem]`}
            >
              <option value="all">Everything</option>
              <option value="transaction">Transactions</option>
              <option value="card">Cards</option>
              <option value="access">Access</option>
            </select>
            <select
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              className={`${fieldClass} max-w-[16rem]`}
            >
              <option value="all">Anyone</option>
              {actors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <span className="tnum text-[13px] text-ink-muted">
              {shown.length}
              {shown.length !== rows.length && (
                <span className="text-ink-faint"> of {rows.length}</span>
              )}{' '}
              {shown.length === 1 ? 'entry' : 'entries'}
            </span>
          </div>

          <Panel>
            {shown.length === 0 ? (
              <EmptyState
                title={rows.length ? 'Nothing matches that' : 'Nothing has been changed yet'}
                description={
                  rows.length
                    ? 'Try a different search, or widen the filters.'
                    : 'Adding, editing or resolving a transaction will appear here, along with card and access changes.'
                }
              />
            ) : (
              <ol className="divide-y divide-line">
                {shown.map((r, i) => (
                  <li key={`${r.created_at}-${i}`} className="px-4 py-3">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <Tag tone={ACTION_TONE[r.action] ?? 'neutral'}>
                        {AREA_LABEL[r.area] ?? r.area} {ACTION_LABEL[r.action] ?? r.action}
                      </Tag>
                      <span className="text-[13px] font-medium text-ink">
                        {r.transaction_id ? (
                          <Link
                            to={`/transactions?q=${encodeURIComponent(r.subject)}`}
                            className="underline decoration-line underline-offset-2 hover:decoration-ink-muted"
                          >
                            {r.subject}
                          </Link>
                        ) : (
                          r.subject
                        )}
                      </span>
                      {r.amount_aed !== null && (
                        <span className="tnum text-[13px]">
                          <Money amount={Number(r.amount_aed)} signed code={false} />
                        </span>
                      )}
                      {r.card_name && r.area === 'transaction' && (
                        <span className="text-xs text-ink-faint">on {r.card_name}</span>
                      )}
                      {r.txn_date && (
                        <span className="text-xs text-ink-faint">dated {r.txn_date}</span>
                      )}
                      <span className="ml-auto whitespace-nowrap text-xs text-ink-faint">
                        {when(r.created_at)}
                      </span>
                    </div>

                    <p className="mt-1 text-[13px] text-ink-muted">
                      <span className="text-ink">{r.actor}</span>
                      {r.from_status && r.to_status && r.from_status !== r.to_status && (
                        <>
                          {' '}
                          — {r.from_status.replace(/_/g, ' ')} →{' '}
                          <span className="text-ink">{r.to_status.replace(/_/g, ' ')}</span>
                        </>
                      )}
                      {r.rationale && <> — {r.rationale}</>}
                    </p>

                    <Changes changes={r.changes} action={r.action} />
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          {rows.length >= 400 && (
            <p className="mt-3 text-xs text-ink-faint">
              Showing the most recent 400 entries.
            </p>
          )}
        </>
      )}
    </Page>
  );
}
