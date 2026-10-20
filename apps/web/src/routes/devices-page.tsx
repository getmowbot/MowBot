import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Monitor, Smartphone, Terminal } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/form';
import { api } from '../lib/auth';

const kindIcon = {
  web: Monitor,
  ios: Smartphone,
  android: Smartphone,
  desktop: Laptop,
  cli: Terminal,
} as const;

const formatDate = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(iso),
      )
    : '—';

export function DevicesPage() {
  const queryClient = useQueryClient();
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/devices');
      if (error || !data) throw error;
      return data.items;
    },
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await api.DELETE('/api/v1/devices/{id}', { params: { path: { id } } });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['devices'] }),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Appareils</h1>
        <p className="text-sm text-muted-foreground">
          Chaque navigateur ou application connecté a sa propre session, révocable à tout moment.
        </p>
      </div>
      <Card className="divide-y p-0">
        {devices.isPending && <p className="p-4 text-sm text-muted-foreground">Chargement…</p>}
        {devices.isError && (
          <p className="p-4 text-sm text-destructive">Impossible de charger les appareils.</p>
        )}
        {devices.data?.map((device) => {
          const Icon = kindIcon[device.kind];
          return (
            <div key={device.id} className="flex flex-wrap items-center gap-3 p-4">
              <Icon className="size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 font-medium">
                  <span className="truncate">{device.name}</span>
                  {device.current && (
                    <span className="rounded bg-primary/15 px-1.5 text-xs text-primary">
                      cet appareil
                    </span>
                  )}
                  {device.revokedAt && (
                    <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">
                      révoqué
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  Connecté le {formatDate(device.createdAt)} · vu {formatDate(device.lastSeenAt)}
                </p>
              </div>
              {!device.current && !device.revokedAt && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => {
                    if (confirm(`Révoquer « ${device.name} » ?`)) revoke.mutate(device.id);
                  }}
                >
                  Révoquer
                </Button>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
