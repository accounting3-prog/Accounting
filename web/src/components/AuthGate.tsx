/**
 * Sign-in, and the honest states around it.
 *
 * Row Level Security grants reads to `authenticated` only, so a signed-out
 * browser legitimately sees an empty ledger rather than an error. Presenting
 * that as "no data" would be misleading, so the session is checked first and
 * the reason for an empty screen is stated plainly.
 *
 * Signing in is optional: the audited sample remains available so the app can
 * be reviewed without an account. What is never done is passing sample figures
 * off as live ones.
 */

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { Button, LoadingState, Notice } from './ui';

export type AuthState =
  | { status: 'checking' }
  | { status: 'signed_out' }
  | { status: 'signed_in'; session: Session }
  | { status: 'not_configured' };

export function useAuth(): AuthState & { signIn: () => void; signOut: () => void } {
  const [state, setState] = useState<AuthState>(
    isSupabaseConfigured ? { status: 'checking' } : { status: 'not_configured' },
  );

  useEffect(() => {
    if (!supabase) return;
    let alive = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setState(data.session ? { status: 'signed_in', session: data.session } : { status: 'signed_out' });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setState(session ? { status: 'signed_in', session } : { status: 'signed_out' });
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return {
    ...state,
    signIn: () => {
      void supabase?.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
    },
    signOut: () => {
      void supabase?.auth.signOut();
    },
  };
}

export function SignInScreen({
  onContinueWithSample,
  onSignIn,
}: {
  onContinueWithSample: () => void;
  onSignIn: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="rounded-md border border-line bg-surface px-6 py-6">
          <h1 className="text-base font-semibold tracking-tight text-ink">Card Ledger</h1>
          <p className="mt-0.5 text-[13px] text-ink-muted">Multi-currency reconciliation</p>

          <p className="mt-4 text-[13px] text-ink">
            The ledger is readable only by signed-in users. Access is enforced in
            the database, so signing in is what makes the figures visible — not a
            screen in front of them.
          </p>

          <div className="mt-5 flex flex-col gap-2">
            <Button variant="primary" onClick={onSignIn}>
              Sign in with Google
            </Button>
            <Button variant="ghost" onClick={onContinueWithSample}>
              Continue without signing in
            </Button>
          </div>

          <p className="mt-3 text-xs text-ink-muted">
            Without an account you will see the audited workbook extract, clearly
            labelled as such. It is correct as of the import but is not live.
          </p>
        </div>
      </div>
    </div>
  );
}

export function AuthChecking() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <LoadingState label="Checking your session" />
    </div>
  );
}

export function SignedOutBanner({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="border-b border-[#e8d5ab] bg-review-soft px-4 py-2">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] text-ink">
          <span className="font-medium">Showing the audited sample.</span> Sign in
          to read the live ledger.
        </p>
        <button
          type="button"
          onClick={onSignIn}
          className="text-[13px] font-medium text-accent hover:underline underline-offset-2"
        >
          Sign in
        </button>
      </div>
    </div>
  );
}

export { Notice };
