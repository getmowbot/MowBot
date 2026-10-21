import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import { WindowControls } from './components/window-controls';
import { AuthProvider } from './lib/auth';
import { router } from './router';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
        <WindowControls />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
