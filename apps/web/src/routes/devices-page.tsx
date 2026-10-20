import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Laptop, Monitor, Smartphone, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/form';
import { api } from '../lib/auth';
import { formatDate } from '../lib/utils';

const kindIcon = {
  web: Monitor,
  ios: Smartphone,
  android: Smartphone,
  desktop: Laptop,
  cli: Terminal,
} as const;

const when = (iso: string | null) =>
  iso ? formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export function DevicesPage() {
  const { t } = useTranslation();
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
        <h1 className="text-2xl font-semibold">{t('shell.devices')}</h1>
        <p className="text-sm text-muted-foreground">{t('devices.subtitle')}</p>
      </div>
      <Card className="divide-y p-0">
        {devices.isPending && (
          <p className="p-4 text-sm text-muted-foreground">{t('common.loading')}</p>
        )}
        {devices.isError && (
          <p className="p-4 text-sm text-destructive">{t('devices.loadFailed')}</p>
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
                      {t('devices.current')}
                    </span>
                  )}
                  {device.revokedAt && (
                    <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">
                      {t('devices.revoked')}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('devices.seen', {
                    created: when(device.createdAt),
                    seen: when(device.lastSeenAt),
                  })}
                </p>
              </div>
              {!device.current && !device.revokedAt && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={revoke.isPending}
                  onClick={() => {
                    if (confirm(t('devices.confirmRevoke', { name: device.name }))) {
                      revoke.mutate(device.id);
                    }
                  }}
                >
                  {t('devices.revoke')}
                </Button>
              )}
            </div>
          );
        })}
      </Card>
    </div>
  );
}
