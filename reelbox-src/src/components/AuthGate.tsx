import { useEffect, useState } from 'react';
import { Lock } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Troy answers every catalog and playback call with 401 until this browser has
 * signed in, so the gate comes before the routes rather than inside each one.
 * The session itself is a cookie the server owns; nothing is stored here.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .session()
      .then(setAuthenticated)
      .catch(() => setAuthenticated(false));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(password);
      setPassword('');
      setAuthenticated(true);
    } catch (e: any) {
      setError(e.message || 'Sign in failed');
    } finally {
      setBusy(false);
    }
  };

  if (authenticated === null) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <p className="text-sm text-muted-foreground">Checking the session…</p>
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-6">
        <form onSubmit={submit} className="w-full max-w-xs">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-primary text-primary-foreground">
            <Lock className="h-5 w-5" />
          </span>
          <h1 className="mt-4 text-center font-display text-xl font-bold">ReelBox</h1>
          <p className="mt-1 text-center text-xs text-muted-foreground">This cinema is private.</p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Password"
            autoComplete="current-password"
            className="mt-6 w-full rounded-full bg-secondary px-4 py-2.5 text-sm outline-none"
          />
          {error && <p className="mt-2 text-center text-xs text-destructive">{error}</p>}
          <button type="submit" disabled={busy} className="btn-primary mt-3 w-full justify-center">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <p className="mt-4 text-center text-[11px] text-muted-foreground">
            The same password as the classic player.
          </p>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
