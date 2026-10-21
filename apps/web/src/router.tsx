import {
  createRootRoute,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  useLocation,
} from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { BotAvatar } from './components/bot-avatar';
import { useAuth } from './lib/auth';
import { ActivityPage } from './routes/activity-page';
import { AppShell } from './routes/app-shell';
import { LoginPage, SetupPage } from './routes/auth-pages';
import { AvatarGallery } from './routes/avatar-gallery';
import { ChatPage } from './routes/chat-page';
import { DesktopPage } from './routes/desktop-page';
import { DevicesPage } from './routes/devices-page';
import { FilesPage } from './routes/files-page';
import { HomePage } from './routes/home-page';
import { McpPage } from './routes/mcp-page';
import { ModelsPage } from './routes/models-page';
import { OrgPage } from './routes/org-page';
import { ProactivityPage } from './routes/proactivity-page';
import { ProfilePage } from './routes/profile-page';
import { ProjectsPage } from './routes/projects-page';
import { RoutinesPage } from './routes/routines-page';
import { TeamPage } from './routes/team-page';
import { VaultPage } from './routes/vault-page';

const PUBLIC_PATHS = ['/setup', '/login'];

/** Sends every visitor to the page matching their auth state. */
function AuthGate() {
  const { t } = useTranslation();
  const { status } = useAuth();
  const { pathname } = useLocation();

  if (status === 'loading' || status === 'offline') {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center">
        <BotAvatar
          seed="mowbot-portier"
          size={72}
          mood={status === 'loading' ? 'thinking' : 'sleeping'}
        />
        <p
          className={
            status === 'loading' ? 'shimmer-text text-sm' : 'text-sm text-muted-foreground'
          }
        >
          {status === 'loading' ? t('gate.connecting') : t('gate.offline')}
        </p>
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
const chefRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/chef',
  component: ChatPage,
});
const botRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/bots/$botId',
  component: ChatPage,
});
const modelsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/models',
  component: ModelsPage,
});
const devicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/devices',
  component: DevicesPage,
});
const vaultRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/vault',
  component: VaultPage,
});
const mcpRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/mcp',
  component: McpPage,
});
const profileRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/profile',
  component: ProfilePage,
});
const projectsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/projects',
  component: ProjectsPage,
});

const routinesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/routines',
  component: RoutinesPage,
});
const proactivityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings/proactivity',
  component: ProactivityPage,
});
const orgRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/org',
  component: OrgPage,
});
const activityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/activity',
  component: ActivityPage,
});
const teamRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/teams/$teamId',
  component: TeamPage,
});
const desktopRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/teams/$teamId/desktop',
  component: DesktopPage,
});
const computerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/computers/$computerId',
  component: DesktopPage,
});
/** `path`: the folder shown; `open`: a file shown in the preview (one a bot presented). */
const filesSearch = (search: Record<string, unknown>): { path?: string; open?: string } => ({
  ...(typeof search.path === 'string' && search.path ? { path: search.path } : {}),
  ...(typeof search.open === 'string' && search.open ? { open: search.open } : {}),
});
const workspaceFilesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/workspaces/$workspaceId/files',
  validateSearch: filesSearch,
  component: FilesPage,
});
const filesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/teams/$teamId/files',
  validateSearch: filesSearch,
  component: FilesPage,
});

// Dev-only: review bot characters at /dev/avatars.
const galleryRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/dev/avatars',
  component: AvatarGallery,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    setupRoute,
    loginRoute,
    appRoute.addChildren([
      homeRoute,
      chefRoute,
      botRoute,
      modelsRoute,
      devicesRoute,
      vaultRoute,
      mcpRoute,
      projectsRoute,
      profileRoute,
      routinesRoute,
      proactivityRoute,
      orgRoute,
      activityRoute,
      teamRoute,
      desktopRoute,
      filesRoute,
      computerRoute,
      workspaceFilesRoute,
      ...(import.meta.env.DEV ? [galleryRoute] : []),
    ]),
  ]),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
