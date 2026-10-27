import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { Loading } from './components/ui';
import type { ServerView as ServerPage, SettingsView as SettingsPage } from './components/pages';

// Pages and dialogs that the first screen never shows load in their own chunks: the Server and
// Settings pages share one, the shared-link dialog has another. The pages are fetched once the
// signed-in portal is idle. A loaded page renders in the same commit that opens it, like a page
// in the main bundle; one opened before its chunk arrives shows Loading until it does.
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
export const ShareDialog = lazy(() => import('./components/Share').then(module => ({ default: module.ShareDialog })));

export function usePrefetchViews(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const prefetch = () => { void loadPages().catch(() => undefined); };
    if ('requestIdleCallback' in window) { const id = requestIdleCallback(prefetch, { timeout: 3000 }); return () => cancelIdleCallback(id); }
    const timer = setTimeout(prefetch, 1500);
    return () => clearTimeout(timer);
  }, [ready]);
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
    return <Suspense fallback={props.active ? <Loading /> : null}><Page {...props} /></Suspense>;
  };
}
export const ServerView = deferred<Parameters<typeof ServerPage>[0]>('ServerView');
export const SettingsView = deferred<Parameters<typeof SettingsPage>[0]>('SettingsView');
