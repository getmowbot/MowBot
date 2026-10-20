import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useLocation,
} from '@tanstack/react-router';
import { useAuth } from './lib/auth';
import { AppShell, HomePage } from './routes/app-shell';
import { LoginPage, SetupPage } from './routes/auth-pages';
import { DevicesPage } from './routes/devices-page';

const PUBLIC_PATHS = ['/setup', '/login'];

/** Sends every visitor to the page matching their auth state. */
function AuthGate() {
  const { status } = useAuth();
  const { pathname } = useLocation();

  if (status === 'loading') {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        Chargement…
      </div>
    );
  }
  if (status === 'offline') {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4 text-center text-muted-foreground">
        Le hub MowBot est injoignable. Vérifie qu'il est démarré puis recharge la page.
      </div>
    );
  }
  if (status === 'setup' && pathname !== '/setup') return <Navigate to="/setup" />;
  if (status === 'anonymous' && pathname !== '/login') return <Navigate to="/login" />;
  if (status === 'authenticated' && PUBLIC_PATHS.includes(pathname)) return <Navigate to="/" />;
  return <Outlet />;
}

const rootRoute = createRootRoute({ component: AuthGate });
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  component: SetupPage,
});
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
});
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppShell });
const homeRoute = createRoute({ getParentRoute: () => appRoute, path: '/', component: HomePage });
const devicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/devices',
  component: DevicesPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    setupRoute,
    loginRoute,
    appRoute.addChildren([homeRoute, devicesRoute]),
  ]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
