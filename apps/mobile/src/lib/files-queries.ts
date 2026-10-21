import type { FileEntry } from '@mowbot/contract';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentPickerAsset } from 'expo-document-picker';
import { Directory, File, Paths, UploadType } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useState } from 'react';
import { FILE_HEAD_BYTES, rangeTotal } from './board';
import {
  contentUrl,
  downloadUrl,
  localFileName,
  mimeTypeFor,
  parentOf,
  sortEntries,
  TEXT_PREVIEW_BYTES,
} from './files';
import { data, keys, useBots, useTeams } from './queries';
import { api, authHeaders, hubUrl } from './session';

/** Every folder listing of a workspace (the event stream invalidates the same prefix). */
const workspaceKey = (workspaceId: string) => ['files', workspaceId] as const;

async function listFolder(workspaceId: string, path: string): Promise<FileEntry[]> {
  const listing = await data(
    api().GET('/api/v1/workspaces/{id}/files', {
      params: { path: { id: workspaceId }, query: { path } },
    }),
  );
  return sortEntries(listing.entries);
}

/**
 * A folder of a workspace. Bots write from inside their computer, which emits no event: like
 * the web, the open folder is polled while it is on screen.
 */
export function useFolder(workspaceId: string, path: string, { poll = false } = {}) {
  return useQuery({
    queryKey: keys.files(workspaceId, path),
    enabled: Boolean(workspaceId),
    refetchInterval: poll ? 5_000 : false,
    queryFn: () => listFolder(workspaceId, path),
  });
}

/** A file, found in its folder's listing (shared with the browser, so usually instant). */
export function useFileEntry(workspaceId: string, path: string, { poll = false } = {}) {
  const folder = useFolder(workspaceId, parentOf(path), { poll });
  return { ...folder, entry: folder.data?.find((entry) => entry.path === path) };
}

const SEARCH_DELAY_MS = 150;

/**
 * Files and folders of a workspace whose path contains `query` (the latest changed for ''),
 * asked of the hub once typing pauses; the previous results stay meanwhile. Null: no search.
 */
export function useFileSearch(
  workspaceId: string | null | undefined,
  query: string | null,
  limit: number,
) {
  const typed = query === null ? null : query.trim();
  const [settled, setSettled] = useState(typed);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(typed), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed]);
  const search = useQuery({
    queryKey: keys.fileSearch(workspaceId ?? '', settled ?? ''),
    enabled: Boolean(workspaceId) && settled !== null,
    placeholderData: keepPreviousData,
    queryFn: async () =>
      (
        await data(
          api().GET('/api/v1/workspaces/{id}/files/search', {
            params: { path: { id: workspaceId as string }, query: { q: settled ?? '', limit } },
          }),
        )
      ).items,
  });
  // Waiting for typing to pause counts: the answer for what is typed is not there yet.
  const searching =
    Boolean(workspaceId) && typed !== null && (typed !== settled || search.isFetching);
  return { ...search, searching };
}

/** Who the files belong to: a team, or a solo bot. */
export function useWorkspaceOwner(workspaceId: string): { name: string | null; pending: boolean } {
  const teams = useTeams();
  const bots = useBots();
  const team = teams.data?.find((t) => t.workspaceId === workspaceId);
  const bot =
    bots.data?.find((b) => !b.teamId && b.workspaceId === workspaceId) ??
    bots.data?.find((b) => b.workspaceId === workspaceId);
  return { name: team?.name ?? bot?.name ?? null, pending: teams.isPending || bots.isPending };
}

/**
 * Makes sure the access token held by the session is valid for a few more seconds: native
 * transfers (images, uploads) send it as is and cannot refresh it on a 401 like typed calls do.
 */
async function freshAuthHeaders(): Promise<Record<string, string>> {
  await api().GET('/api/v1/me');
  return authHeaders();
}

/** Headers for an image loaded by URL, re-checked each time a preview opens. */
export function useImageSource(workspaceId: string, entry: FileEntry | undefined, attempt: number) {
  const hub = hubUrl();
  const path = entry?.path;
  const version = entry?.modifiedAt;
  const headers = useQuery({
    queryKey: ['file-auth', workspaceId, path, version, attempt],
    enabled: Boolean(path && hub),
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: freshAuthHeaders,
  });
  // One object per image version: a new one would make expo-image load it again.
  return useMemo(
    () =>
      path && hub && headers.data
        ? {
            uri: contentUrl(hub, workspaceId, path),
            headers: headers.data,
            cacheKey: `${workspaceId}:${path}:${version}`,
          }
        : null,
    [hub, workspaceId, path, version, headers.data],
  );
}

/** The text of a file; only its beginning when it is long. */
export function useFileText(workspaceId: string, entry: FileEntry | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['file-content', workspaceId, entry?.path, entry?.modifiedAt],
    enabled: Boolean(entry) && enabled,
    gcTime: 60_000,
    // A bot rewriting the file refreshes the preview without flashing a spinner.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const file = entry as FileEntry;
      const truncated = file.size > TEXT_PREVIEW_BYTES;
      const { data: text, error } = await api().GET('/api/v1/workspaces/{id}/files/content', {
        params: { path: { id: workspaceId }, query: { path: file.path } },
        parseAs: 'text',
        headers: truncated ? { range: `bytes=0-${TEXT_PREVIEW_BYTES - 1}` } : undefined,
      });
      if (error !== undefined) throw error;
      // An empty file comes back without a body.
      return { text: typeof text === 'string' ? text : '', truncated };
    },
  });
}

/**
 * The beginning of a file a bot presented (its card's preview): one small Range request, never
 * the whole file. `version` changes when the card does. `cut`: the file goes on past it.
 */
export function useFileHead(
  workspaceId: string | null,
  path: string,
  version: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ['file-head', workspaceId, path, version],
    enabled: Boolean(workspaceId) && enabled,
    // Chat rows remount as they scroll: no refetch for each.
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    queryFn: async () => {
      const {
        data: text,
        error,
        response,
      } = await api().GET('/api/v1/workspaces/{id}/files/content', {
        params: { path: { id: workspaceId as string }, query: { path } },
        parseAs: 'text',
        headers: { range: `bytes=0-${FILE_HEAD_BYTES - 1}` },
      });
      // Emptied since: no range to give.
      if (response.status === 416) return { text: '', cut: false };
      if (error !== undefined) throw error;
      const total = rangeTotal(response.headers.get('content-range'));
      return {
        text: typeof text === 'string' ? text : '',
        cut: response.status === 206 && total !== null && total > FILE_HEAD_BYTES,
      };
    },
  });
}

/** Fresh directory under the cache; `slot` is emptied first (its previous files are done). */
function cacheDirectory(slot: string): Directory {
  const root = new Directory(Paths.cache, slot);
  if (root.exists) root.delete();
  const dir = new Directory(root, String(Date.now()));
  dir.create({ intermediates: true });
  return dir;
}

interface DownloadOptions {
  /** `share` and `preview` use separate cache folders so one never deletes the other's file. */
  slot?: 'share' | 'preview';
  onProgress?(fraction: number | null): void;
}

/**
 * Downloads a file (or a folder as a zip) to the cache through a one-time link, which needs no
 * auth header: the hub serves `/downloads/{ticket}` to whoever holds it.
 */
export async function downloadToCache(
  workspaceId: string,
  path: string,
  fileName: string,
  { slot = 'share', onProgress }: DownloadOptions = {},
): Promise<File> {
  const hub = hubUrl();
  if (!hub) throw new Error('No hub');
  const { ticket } = await data(
    api().POST('/api/v1/workspaces/{id}/files/download-ticket', {
      params: { path: { id: workspaceId } },
      body: { path },
    }),
  );
  const target = new File(cacheDirectory(`mowbot-${slot}`), localFileName(fileName));
  return File.downloadFileAsync(downloadUrl(hub, ticket), target, {
    idempotent: true,
    onProgress: onProgress
      ? ({ bytesWritten, totalBytes }) =>
          onProgress(totalBytes > 0 ? Math.min(1, bytesWritten / totalBytes) : null)
      : undefined,
  });
}

export class SharingUnavailable extends Error {}

/** The system share sheet: save to Files, AirDrop, open in another app… */
export async function shareLocalFile(file: File, name: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new SharingUnavailable();
  await Sharing.shareAsync(file.uri, { mimeType: mimeTypeFor(name), dialogTitle: name });
}

class UploadFailed extends Error {
  constructor(readonly problem: unknown) {
    super('Upload failed');
  }
}

/**
 * Stages a picked document under its real name (the multipart part is named after the local
 * file), then posts it like the web does: one `file` part, into `dir`.
 */
async function uploadOne(
  workspaceId: string,
  dir: string,
  asset: DocumentPickerAsset,
): Promise<void> {
  const hub = hubUrl();
  if (!hub) throw new Error('No hub');
  const staged = new File(cacheDirectory('mowbot-upload'), localFileName(asset.name));
  await new File(asset.uri).copy(staged);
  const url = `${hub}/api/v1/workspaces/${encodeURIComponent(workspaceId)}/files/upload?path=${encodeURIComponent(dir)}`;
  const send = async () =>
    staged.upload(url, {
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      mimeType: asset.mimeType ?? mimeTypeFor(asset.name),
      headers: await freshAuthHeaders(),
      sessionType: 'foreground',
    });
  try {
    let result = await send();
    // The token expired mid-way: one more try with a refreshed one.
    if (result.status === 401) result = await send();
    if (result.status < 200 || result.status >= 300) {
      let problem: unknown = null;
      try {
        problem = JSON.parse(result.body);
      } catch {
        // Not a problem document.
      }
      throw new UploadFailed(problem);
    }
  } finally {
    if (staged.parentDirectory.exists) staged.parentDirectory.delete();
  }
}

/** The error to inspect (`fileProblem`) when an upload fails. */
export function uploadProblem(error: unknown): unknown {
  return error instanceof UploadFailed ? error.problem : error;
}

/** Changes to a workspace's files; every folder listing refreshes after each. */
export function useFileMutations(workspaceId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: workspaceKey(workspaceId) });
  const params = { params: { path: { id: workspaceId } } };

  const mkdir = useMutation({
    mutationFn: (path: string) =>
      data(api().POST('/api/v1/workspaces/{id}/files/mkdir', { ...params, body: { path } })),
    onSettled: refresh,
  });

  const move = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      data(api().POST('/api/v1/workspaces/{id}/files/move', { ...params, body: { from, to } })),
    // A renamed file stays in its listing, so a preview following it never misses it.
    onSuccess: (moved, { from }) => {
      client.setQueryData<FileEntry[]>(keys.files(workspaceId, parentOf(from)), (entries) => {
        if (!entries) return entries;
        const rest = entries.filter((entry) => entry.path !== from);
        return parentOf(moved.path) === parentOf(from) ? sortEntries([...rest, moved]) : rest;
      });
    },
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: (path: string) =>
      data(
        api().DELETE('/api/v1/workspaces/{id}/files', {
          params: { path: { id: workspaceId }, query: { path } },
        }),
      ),
    // Gone from the list at once; the refetch confirms.
    onMutate: (path) => {
      client.setQueryData<FileEntry[]>(keys.files(workspaceId, parentOf(path)), (entries) =>
        entries?.filter((entry) => entry.path !== path),
      );
    },
    onSettled: refresh,
  });

  const upload = useMutation({
    mutationFn: async ({
      dir,
      assets,
      onFile,
    }: {
      dir: string;
      assets: DocumentPickerAsset[];
      onFile?(asset: DocumentPickerAsset): void;
    }) => {
      for (const asset of assets) {
        onFile?.(asset);
        await uploadOne(workspaceId, dir, asset);
      }
      return assets.length;
    },
    onSettled: refresh,
  });

  return { mkdir, move, remove, upload };
}
