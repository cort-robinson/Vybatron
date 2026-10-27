import { Component, lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import { ErrorState, Loading } from './components/ui';
import type { ServerView as ServerPage, SettingsView as SettingsPage } from './components/pages';

// The Server and Settings pages aren't on the first screen, so they load as one chunk of their
// own, fetched once the signed-in portal is idle. A loaded page renders in the same commit that
// opens it, like a page in the main bundle; one opened before its chunk arrives shows Loading.
type Pages = typeof import('./components/pages');
let pages: Pages | undefined;
let pending: Promise<Pages> | undefined;
function loadPages() {
  pending ??= import('./components/pages').then(module => (pages = module), error => { pending = undefined; throw error; });
  return pending;
}
const lazyPages = {
  ServerView: lazy(() => loadPages().then(module => ({ default: module.ServerView }))),
  SettingsView: lazy(() => loadPages().then(module => ({ default: module.SettingsView }))),
};

export function usePrefetchViews(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const prefetch = () => { void loadPages().catch(() => undefined); };
    if ('requestIdleCallback' in window) { const id = requestIdleCallback(prefetch, { timeout: 3000 }); return () => cancelIdleCallback(id); }
    const timer = setTimeout(prefetch, 1500);
    return () => clearTimeout(timer);
  }, [ready]);
}

// A chunk that fails to arrive (offline before the worker cached it) shows an error in the page's
// place; the rest of the portal keeps working. The browser won't refetch a script chunk that
// failed, so trying again reloads the portal.
class ChunkBoundary extends Component<{ active: boolean; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return this.props.active ? <ErrorState message="This page couldn’t load. Check your connection, then try again to reload Vybatron." retry={() => location.reload()} /> : null;
  }
}

// A page mounts the first time it's opened and then stays mounted, hidden while another page
// shows, as the pages in the main bundle do.
function deferred<P extends { active?: boolean }>(name: keyof Pages): ComponentType<P> {
  return function DeferredPage(props: P) {
    // Chosen once, when first opened: switching component types later would remount the page.
    const choose = () => (pages?.[name] ?? lazyPages[name]) as unknown as ComponentType<P>;
    const [Page, setPage] = useState<ComponentType<P> | null>(() => props.active ? choose() : null);
    if (props.active && !Page) setPage(() => choose());
    if (!Page) return null;
    return <ChunkBoundary active={!!props.active}><Suspense fallback={props.active ? <Loading /> : null}><Page {...props} /></Suspense></ChunkBoundary>;
  };
}
export const ServerView = deferred<Parameters<typeof ServerPage>[0]>('ServerView');
export const SettingsView = deferred<Parameters<typeof SettingsPage>[0]>('SettingsView');
