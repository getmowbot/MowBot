import { type FileEntry, TRASH_FOLDER } from '@mowbot/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import {
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
} from 'lucide-react';
import { type DragEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilePreview } from '../components/file-preview';
import { Button } from '../components/ui/button';
import { Card } from '../components/ui/form';
import { i18n } from '../i18n';
import { api, apiBaseUrl, client, problemMessage } from '../lib/auth';
import { useBots, useTeams } from '../lib/queries';
import { cn, formatDate } from '../lib/utils';

const label = (name: string) => (name === TRASH_FOLDER ? i18n.t('files.trash') : name);

const UNITS = ['kb', 'mb', 'gb', 'tb'] as const;

/** `1,5 Mo` / `1.5 MB` */
const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} ${i18n.t('files.units.b')}`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = value < 10 ? 1 : 0;
  const number = new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return `${number} ${i18n.t(`files.units.${UNITS[unit] ?? 'tb'}`)}`;
};

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

export function FilesPage() {
  const { t } = useTranslation();
  // A team's files (/teams/:id/files) or any workspace (/workspaces/:id/files), e.g. a solo bot's.
  const route = useParams({ strict: false }) as { teamId?: string; workspaceId?: string };
  const search = useSearch({ strict: false }) as { path?: string };
  const dir = search.path ?? '';
  const teams = useTeams();
  const bots = useBots();
  const team = teams.data?.find((t) =>
    route.teamId ? t.id === route.teamId : t.workspaceId === route.workspaceId,
  );
  const workspaceId = route.workspaceId ?? team?.workspaceId;
  const owner =
    team?.name ?? bots.data?.find((b) => !b.teamId && b.workspaceId === workspaceId)?.name;
  const queryClient = useQueryClient();
  const uploadInput = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listing = useQuery({
    queryKey: ['files', workspaceId, dir],
    enabled: Boolean(workspaceId),
    // Bots write from inside their computer, which emits no event: poll while the page is open.
    refetchInterval: 5_000,
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{id}/files', {
        params: { path: { id: workspaceId as string }, query: { path: dir } },
      });
      if (error || !data) throw error;
      // The trash goes last, after the regular folders and files.
      return [...data.entries].sort(
        (a, b) => Number(a.path === TRASH_FOLDER) - Number(b.path === TRASH_FOLDER),
      );
    },
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['files', workspaceId] });
  const params = { params: { path: { id: workspaceId as string } } };
  const onError = (err: unknown) => setError(problemMessage(err, t('common.actionFailed')));

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append('file', file, file.name);
      const response = await client.fetch(
        `/api/v1/workspaces/${workspaceId}/files/upload?path=${encodeURIComponent(dir)}`,
        { method: 'POST', body: form },
      );
      if (!response.ok) throw await response.json().catch(() => null);
    },
    onSuccess: refresh,
    onError,
  });

  const mkdir = useMutation({
    mutationFn: async (name: string) => {
      const { error } = await api.POST('/api/v1/workspaces/{id}/files/mkdir', {
        ...params,
        body: { path: join(dir, name) },
      });
      if (error) throw error;
    },
    onSuccess: refresh,
    onError,
  });

  const rename = useMutation({
    mutationFn: async ({ entry, name }: { entry: FileEntry; name: string }) => {
      const { error } = await api.POST('/api/v1/workspaces/{id}/files/move', {
        ...params,
        body: { from: entry.path, to: join(dir, name) },
      });
      if (error) throw error;
    },
    onSuccess: refresh,
    onError,
  });

  const remove = useMutation({
    mutationFn: async (entry: FileEntry) => {
      const { error } = await api.DELETE('/api/v1/workspaces/{id}/files', {
        params: { path: { id: workspaceId as string }, query: { path: entry.path } },
      });
      if (error) throw error;
    },
    onSuccess: refresh,
    onError,
  });

  /** Single-use link: the browser downloads it natively (no auth header needed). */
  const download = async (path: string) => {
    const { data, error } = await api.POST('/api/v1/workspaces/{id}/files/download-ticket', {
      params: { path: { id: workspaceId as string } },
      body: { path },
    });
    if (error || !data) return onError(error);
    const link = document.createElement('a');
    link.href = `${apiBaseUrl}/api/v1/downloads/${encodeURIComponent(data.ticket)}`;
    link.rel = 'noopener';
    link.click();
  };

  const inTrash = dir === TRASH_FOLDER || dir.startsWith(`${TRASH_FOLDER}/`);
  const crumbs = dir ? dir.split('/') : [];

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) upload.mutate(files);
  };

  if (teams.isPending) {
    return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  }
  if (!workspaceId) return <p className="text-sm text-destructive">{t('files.notFound')}</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-muted-foreground">{owner ?? t('common.files')}</p>
          <nav
            aria-label={t('files.currentFolder')}
            className="flex flex-wrap items-center gap-1 text-xl font-semibold"
          >
            <Link to="." search={{}} className="hover:underline">
              {t('common.files')}
            </Link>
            {crumbs.map((segment, index) => (
              <span key={crumbs.slice(0, index + 1).join('/')} className="flex items-center gap-1">
                <ChevronRight className="size-4 text-muted-foreground" />
                <Link
                  to="."
                  search={{ path: crumbs.slice(0, index + 1).join('/') }}
                  className="hover:underline"
                >
                  {label(segment)}
                </Link>
              </span>
            ))}
          </nav>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              const name = prompt(t('files.newFolderPrompt'));
              if (name?.trim()) mkdir.mutate(name.trim());
            }}
          >
            <FolderPlus className="size-4" /> {t('files.folder')}
          </Button>
          <Button variant="outline" onClick={() => void download(dir)}>
            <Download className="size-4" /> {t('files.downloadAll')}
          </Button>
          <Button onClick={() => uploadInput.current?.click()} disabled={upload.isPending}>
            <Upload className="size-4" />{' '}
            {upload.isPending ? t('files.uploading') : t('files.upload')}
          </Button>
          <input
            ref={uploadInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              if (files.length > 0) upload.mutate(files);
              event.target.value = '';
            }}
          />
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}{' '}
          <button type="button" className="underline" onClick={() => setError(null)}>
            {t('common.ok')}
          </button>
        </p>
      )}

      <Card
        className={cn('relative p-0', dragging && 'ring-2 ring-primary')}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {listing.isPending && (
          <p className="p-4 text-sm text-muted-foreground">{t('common.loading')}</p>
        )}
        {listing.isError && <p className="p-4 text-sm text-destructive">{t('files.notFound')}</p>}
        {listing.data?.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">{t('files.empty')}</p>
        )}
        <ul className="divide-y">
          {listing.data?.map((entry) => (
            <li
              key={entry.path}
              className="group flex items-center gap-3 px-4 py-2 hover:bg-muted/50"
            >
              {entry.type === 'directory' ? (
                <Folder className="size-5 shrink-0 text-primary" />
              ) : (
                <FileIcon className="size-5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                {entry.type === 'directory' ? (
                  <Link
                    to="."
                    search={{ path: entry.path }}
                    className="block truncate font-medium hover:underline"
                  >
                    {label(entry.name)}
                  </Link>
                ) : (
                  <button
                    type="button"
                    className="block max-w-full truncate text-left hover:underline"
                    onClick={() => setPreview(entry)}
                  >
                    {entry.name}
                  </button>
                )}
                <p className="text-xs text-muted-foreground">
                  {entry.type === 'file' ? `${formatSize(entry.size)} · ` : ''}
                  {formatDate(entry.modifiedAt, { dateStyle: 'short', timeStyle: 'short' })}
                </p>
              </div>
              <div className="flex shrink-0 gap-1 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('files.download', { name: entry.name })}
                  onClick={() => void download(entry.path)}
                >
                  <Download className="size-4" />
                </Button>
                {entry.path !== TRASH_FOLDER && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('files.rename', { name: entry.name })}
                      onClick={() => {
                        const name = prompt(t('files.renamePrompt'), entry.name);
                        if (name?.trim() && name.trim() !== entry.name) {
                          rename.mutate({ entry, name: name.trim() });
                        }
                      }}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('common.deleteNamed', { name: entry.name })}
                      onClick={() => {
                        const question = t(inTrash ? 'files.confirmPurge' : 'files.confirmTrash', {
                          name: entry.name,
                        });
                        if (confirm(question)) remove.mutate(entry);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {preview && workspaceId && (
        <FilePreview
          workspaceId={workspaceId}
          entry={preview}
          onClose={() => setPreview(null)}
          onDownload={(entry) => void download(entry.path)}
        />
      )}
    </div>
  );
}
