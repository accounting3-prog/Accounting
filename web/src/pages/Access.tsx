/**
 * Who can read, and who can change.
 *
 * Reading is not granted here: anyone who signs in can already see the whole
 * ledger, which is the default and needs no administration. This page is only
 * about the smaller set who may move money.
 *
 * Every grant and revoke goes through a database function that records who did
 * it, to whom, and why, in a table that can be appended to and read but never
 * edited — so the history of who was given the ability to change a balance
 * cannot be quietly rewritten by the people it holds to account.
 */

import { useCallback, useEffect, useState } from 'react';
import { Page } from '../components/Layout';
import { useLedgerState } from '../components/LedgerProvider';
import {
  Button,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Notice,
  Panel,
  Tag,
  fieldClass,
} from '../components/ui';
import {
  grantAdmin,
  listAccessAudit,
  listAppUsers,
  revokeAdmin,
  type AccessAuditRow,
  type AppUser,
} from '../lib/api';
import { formatDate } from '../lib/format';

function when(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return `${formatDate(iso.slice(0, 10))}, ${d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  })}`;
}

export function Access() {
  const { signedIn, source } = useLedgerState();
  const connected = signedIn && source === 'supabase';

  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [audit, setAudit] = useState<AccessAuditRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [rationale, setRationale] = useState('');

  const load = useCallback(async () => {
    if (!connected) return;
    setLoadError(null);
    const result = await listAppUsers();
    if (!result.ok) {
      setLoadError(result.error);
      setUsers([]);
      return;
    }
    setUsers(result.users);
    const a = await listAccessAudit();
    if (a.ok) setAudit(a.rows);
  }, [connected]);

  useEffect(() => {
    void load();
  }, [load]);

  const doGrant = async () => {
    if (!email.trim()) return;
    setBusy('grant');
    setActionError(null);
    setMessage(null);
    const r = await grantAdmin(email.trim(), rationale.trim());
    setBusy(null);
    if (r.ok) {
      setMessage(`${email.trim()} can now make changes.`);
      setEmail('');
      setRationale('');
      void load();
    } else setActionError(r.error);
  };

  const doRevoke = async (u: AppUser) => {
    setBusy(u.user_id);
    setActionError(null);
    setMessage(null);
    const r = await revokeAdmin(u.user_id, `Access removed from the access screen.`);
    setBusy(null);
    if (r.ok) {
      setMessage(`${u.email} is now view-only.`);
      void load();
    } else setActionError(r.error);
  };

  if (!connected) {
    return (
      <Page title="Access">
        <Notice tone="review" title="This screen needs an admin session">
          Managing who can change the ledger is itself a change to the ledger, so
          it needs a signed-in admin account and a live connection.
        </Notice>
      </Page>
    );
  }

  const admins = users?.filter((u) => u.is_admin) ?? [];
  const viewers = users?.filter((u) => !u.is_admin) ?? [];

  return (
    <Page
      title="Access"
      description="Everyone who signs in can read the whole ledger. Only the people named here can change it."
      actions={<Button onClick={() => void load()}>Refresh</Button>}
    >
      {loadError ? (
        <ErrorState
          title="Could not read the access list"
          detail={
            loadError.includes('42501') || /admin/i.test(loadError)
              ? 'Listing accounts is limited to admins. Your account can read the ledger but not manage access.'
              : loadError
          }
          onRetry={() => void load()}
        />
      ) : users === null ? (
        <Panel>
          <LoadingState label="Loading accounts" />
        </Panel>
      ) : (
        <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr] xl:items-start">
          <div className="space-y-5">
            <Panel
              title="Can make changes"
              description="Add cards, add transactions, resolve review items, and manage access."
            >
              {admins.length === 0 ? (
                <EmptyState title="Nobody has write access" />
              ) : (
                <ul className="divide-y divide-line">
                  {admins.map((u) => (
                    <li key={u.user_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-ink">
                            {u.email}
                          </span>
                          <Tag tone="accent">Admin</Tag>
                        </div>
                        <div className="mt-0.5 text-xs text-ink-muted">
                          Last signed in {when(u.last_sign_in)}
                        </div>
                      </div>
                      <Button
                        variant="danger"
                        disabled={busy === u.user_id || admins.length <= 1}
                        title={
                          admins.length <= 1
                            ? 'The only admin cannot be removed — grant access to someone else first'
                            : undefined
                        }
                        onClick={() => void doRevoke(u)}
                      >
                        {busy === u.user_id ? 'Removing…' : 'Make view-only'}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Can view"
              description="Read-only. This is what every signed-in account gets by default."
            >
              {viewers.length === 0 ? (
                <EmptyState
                  title="No view-only accounts yet"
                  description="Anyone who signs in appears here automatically."
                />
              ) : (
                <ul className="divide-y divide-line">
                  {viewers.map((u) => (
                    <li key={u.user_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] text-ink">{u.email}</div>
                        <div className="mt-0.5 text-xs text-ink-muted">
                          Last signed in {when(u.last_sign_in)}
                        </div>
                      </div>
                      <Button
                        disabled={busy === 'grant'}
                        onClick={() => {
                          setEmail(u.email);
                          setRationale('');
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        Give change access
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel
              title="Access history"
              description="Append-only. Entries here cannot be edited or removed."
            >
              {audit.length === 0 ? (
                <EmptyState title="No access changes recorded yet" />
              ) : (
                <ul className="divide-y divide-line">
                  {audit.map((r) => (
                    <li key={r.id} className="px-4 py-2.5 text-[13px]">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <Tag tone={r.action === 'granted' ? 'accent' : 'negative'}>
                          {r.action === 'granted' ? 'Granted' : 'Revoked'}
                        </Tag>
                        <span className="font-medium text-ink">{r.target_email}</span>
                        <span className="text-ink-muted">
                          by {r.performed_by_email ?? 'unknown'} · {when(r.created_at)}
                        </span>
                      </div>
                      {r.rationale && (
                        <p className="mt-0.5 text-xs text-ink-muted">{r.rationale}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="space-y-4 xl:sticky xl:top-5">
            <Panel title="Give someone change access">
              <div className="space-y-4 px-4 py-4">
                <Field
                  label="Email address"
                  required
                  hint="They must have signed in at least once, so access is given to a real account rather than an address someone might claim later."
                >
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@events-explorers.com"
                    className={fieldClass}
                  />
                </Field>
                <Field label="Reason" hint="Recorded permanently against this change.">
                  <textarea
                    value={rationale}
                    onChange={(e) => setRationale(e.target.value)}
                    rows={2}
                    placeholder="e.g. Joining the accounting team."
                    className={fieldClass}
                  />
                </Field>
                <Button
                  variant="primary"
                  disabled={!email.trim() || busy === 'grant'}
                  onClick={() => void doGrant()}
                >
                  {busy === 'grant' ? 'Granting…' : 'Give change access'}
                </Button>
              </div>
            </Panel>

            {message && (
              <Notice tone="accent" title="Done">
                {message}
              </Notice>
            )}
            {actionError && (
              <Notice tone="negative" title="The database refused this change">
                <p>{actionError}</p>
                <p className="mt-1.5 text-ink-muted">Nothing was changed.</p>
              </Notice>
            )}

            <Notice tone="review" title="What an admin can do">
              Add cards and transactions, resolve review items, and grant or
              remove access. Everything they change is recorded with their name.
              The last remaining admin cannot be removed, so the account can never
              be locked out of itself.
            </Notice>
          </div>
        </div>
      )}
    </Page>
  );
}
