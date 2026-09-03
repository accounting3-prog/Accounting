/**
 * Loads the ledger once and holds the whole app until it has real data.
 *
 * Pages read through the plain selectors in lib/ledger.ts, so none of them had
 * to change when the source moved from a bundled extract to Supabase. The cost
 * of that is this gate: nothing renders until the data behind those selectors
 * is in place, which is the right trade for a ledger — a page that renders a
 * balance from a half-loaded store is worse than one that renders a moment late.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { loadLedger, type LedgerSource, type LoadFailure } from '../lib/api';
import { setLedgerData } from '../lib/ledger';
import { isSupabaseConfigured } from '../lib/supabase';
import { AuthChecking, SignInScreen, SignedOutBanner, useAuth } from './AuthGate';
import { Button, ErrorState, LoadingState, Notice } from './ui';

type Status = 'loading' | 'ready' | 'empty';

interface LedgerState {
  status: Status;
  source: LedgerSource;
  failure?: LoadFailure;
  /** Bumped on every successful load so consumers re-render. */
  version: number;
  reload: () => void;
  signedIn: boolean;
  signOut: () => void;
}

const Ctx = createContext<LedgerState | null>(null);

export function useLedgerState(): LedgerState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useLedgerState must be used inside LedgerProvider');
  return ctx;
}

export function LedgerProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [skipAuth, setSkipAuth] = useState(false);
  const [status, setStatus] = useState<Status>('loading');
  const [source, setSource] = useState<LedgerSource>('sample');
  const [failure, setFailure] = useState<LoadFailure | undefined>();
  const [version, setVersion] = useState(0);

  const load = useCallback(async (signedIn: boolean) => {
    setStatus('loading');
    setFailure(undefined);
    const result = await loadLedger({ signedIn });
    setLedgerData(result.data);
    setSource(result.source);
    setFailure(result.failure);
    setVersion((v) => v + 1);
    setStatus(result.data.cards.length === 0 ? 'empty' : 'ready');
  }, []);

  const signedIn = auth.status === 'signed_in';

  useEffect(() => {
    // Reload whenever the session changes: signing in turns the sample into the
    // real ledger, and signing out must not leave live figures on screen.
    if (auth.status === 'checking') return;
    void load(auth.status === 'signed_in');
  }, [load, auth.status]);

  const state: LedgerState = {
    status,
    source,
    failure,
    version,
    reload: () => void load(signedIn),
    signedIn,
    signOut: auth.signOut,
  };

  if (auth.status === 'checking') return <AuthChecking />;

  // Signed out with a backend configured: say so, rather than showing an empty
  // ledger that looks like missing data.
  if (auth.status === 'signed_out' && !skipAuth) {
    return (
      <SignInScreen
        onSignIn={auth.signIn}
        onContinueWithSample={() => setSkipAuth(true)}
      />
    );
  }

  const banner =
    isSupabaseConfigured && !signedIn ? <SignedOutBanner onSignIn={auth.signIn} /> : null;

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LoadingState label="Loading the ledger" />
      </div>
    );
  }

  // A live read that failed is reported as itself. The sample data behind it is
  // still shown so the app is usable, but never passed off as live figures.
  if (failure) {
    return (
      <Ctx.Provider value={state}>
        <div className="mx-auto max-w-3xl px-4 py-10">
          {failure.kind === 'permission_denied' ? (
            <ErrorState
              title="You do not have access to this ledger"
              detail={
                'The database refused the read. Everyone signed in may view the ledger, ' +
                'so this usually means the session has expired or the account has not ' +
                `been granted access yet. (${failure.message})`
              }
              onRetry={state.reload}
            />
          ) : (
            <ErrorState
              title="Could not reach the database"
              detail={
                `The app could not read from Supabase. (${failure.message}) ` +
                'Check the connection and the VITE_SUPABASE_URL setting, then try again.'
              }
              onRetry={state.reload}
            />
          )}
          <div className="mt-4">
            <Notice tone="review" title="Showing the audited sample instead">
              The figures below come from the workbook extraction bundled with the
              app, not from the live database. They are correct as of the import,
              but they are not live.
            </Notice>
          </div>
          <div className="mt-4">{children}</div>
        </div>
      </Ctx.Provider>
    );
  }

  if (status === 'empty') {
    return (
      <Ctx.Provider value={state}>
        <div className="mx-auto max-w-3xl px-4 py-16 text-center">
          <h1 className="text-lg font-semibold tracking-tight">No cards yet</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
            {signedIn
              ? 'The database is reachable but holds no cards. Run the importer to load the workbook, then reload this page.'
              : 'Reads are granted to signed-in users only, so an unauthenticated session sees an empty ledger. Sign in, or run the importer if this account should already see data.'}
          </p>
          <pre className="mx-auto mt-4 w-fit rounded-sm border border-line bg-sunken px-3 py-2 text-left font-mono text-xs">
            node scripts/db/import.mjs --live
          </pre>
          <div className="mt-4">
            <Button onClick={state.reload}>Reload</Button>
          </div>
        </div>
      </Ctx.Provider>
    );
  }

  return (
    <Ctx.Provider value={state}>
      {banner}
      {children}
    </Ctx.Provider>
  );
}

/** Where the figures on screen came from, for the sidebar. */
export function useDataSourceLabel(): { label: string; live: boolean } {
  const { source } = useLedgerState();
  if (source === 'supabase') return { label: 'Supabase (live)', live: true };
  return {
    label: isSupabaseConfigured ? 'Sample — live read failed' : 'Audited workbook sample',
    live: false,
  };
}
