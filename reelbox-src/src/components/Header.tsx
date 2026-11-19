import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Play, Search } from 'lucide-react';

export function Header() {
  const [q, setQ] = useState('');
  const nav = useNavigate();

  return (
    <header className="glass sticky top-0 z-40 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-border px-3 py-2.5">
      <Link to="/" className="flex shrink-0 items-center gap-1.5 font-display text-lg font-bold">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary text-primary-foreground">
          <Play className="h-3.5 w-3.5 fill-current" />
        </span>
        ReelBox
      </Link>
      <form
        className="flex min-w-0 items-center gap-2 rounded-full bg-secondary px-3 py-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          nav({ to: '/browse', search: { q, g: undefined, t: undefined } });
        }}
      >
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          aria-label="Search"
          className="w-full min-w-0 bg-transparent text-sm outline-none"
        />
      </form>
      {/* The classic player is still reachable while the new UI beds in: one
          link, no hidden state, and easy to remove once it is not needed. */}
      <a
        href="/classic/"
        className="col-span-2 -mt-1 text-right text-[10px] text-muted-foreground"
        title="Open the previous interface"
      >
        Classic player
      </a>
    </header>
  );
}
