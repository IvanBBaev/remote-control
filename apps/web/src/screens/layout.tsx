import type { ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router';

export interface ScreenProps {
  readonly title: string;
  /** Route of the "back" link in the header, when the screen has a parent. */
  readonly back?: string;
  readonly children?: ReactNode;
}

/** One screen: a header with the title (the `<h1>`) and the content below it. */
export function Screen({ title, back, children }: ScreenProps) {
  return (
    <section className="screen" aria-labelledby="screen-title">
      <header className="screen-header">
        {back !== undefined && (
          <Link className="back" to={back} aria-label="Back">
            ‹
          </Link>
        )}
        <h1 id="screen-title">{title}</h1>
      </header>
      <div className="screen-body">{children}</div>
    </section>
  );
}

/** Empty, offline and error states share one look (01 §5.6). */
export function Notice({ children }: { readonly children: ReactNode }) {
  return <p className="notice">{children}</p>;
}

/** Layout of the signed-in, onboarded app: the screen plus the tab bar. */
export function AppShell() {
  return (
    <div className="app-shell">
      <main className="app-main">
        <Outlet />
      </main>
      <nav className="tab-bar" aria-label="Main">
        <NavLink to="/sessions">Sessions</NavLink>
        <NavLink to="/machines">Computers</NavLink>
      </nav>
    </div>
  );
}

/** Layout of the screens shown before onboarding is complete: no tab bar. */
export function BareShell() {
  return (
    <main className="app-main bare">
      <Outlet />
    </main>
  );
}
