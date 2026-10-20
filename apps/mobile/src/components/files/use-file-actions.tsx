import type { FileEntry } from '@mowbot/contract';
import * as DocumentPicker from 'expo-document-picker';
import { router } from 'expo-router';
import {
  Download,
  FolderInput,
  FolderPlus,
  Pencil,
  Share,
  Share2,
  Trash2,
  Upload,
} from 'lucide-react-native';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  baseName,
  displayName,
  isInTrash,
  joinPath,
  originalName,
  parentOf,
  TRASH_FOLDER,
  validName,
} from '../../lib/files';
import {
  downloadToCache,
  SharingUnavailable,
  shareLocalFile,
  uploadProblem,
  useFileMutations,
} from '../../lib/files-queries';
import { problemCode } from '../../lib/hub-url';
import { alertError, confirm, type MenuOption, openOptions } from '../../lib/options-menu';
import { isIOS } from '../../lib/platform';
import { useNamePrompt } from './name-prompt';

const ShareIcon = isIOS ? Share : Share2;

interface Options {
  workspaceId: string;
  /** The folder on screen (uploads and new folders go there). */
  dir: string;
  /** Name of the workspace's owner, for the zip of its root. */
  ownerName: string | null;
  /** The entry shown was renamed (a preview follows it). */
  onRenamed?(to: string): void;
  /** The entry shown was deleted (a preview closes). */
  onDeleted?(path: string): void;
}

/** Everything the user can do with files, shared by the browser and the preview. */
export function useFileActions({ workspaceId, dir, ownerName, onRenamed, onDeleted }: Options): {
  openEntryMenu(entry: FileEntry, options?: { move?: boolean }): void;
  openFolderMenu(): void;
  share(entry: Pick<FileEntry, 'path' | 'type'>): void;
  upload(): void;
  /** What is under way, for a banner. */
  busy: string | null;
  /** The name prompt (Android): render it once in the screen. */
  element: ReactNode;
} {
  const { t } = useTranslation();
  const mutations = useFileMutations(workspaceId);
  const prompt = useNamePrompt();
  const [busy, setBusy] = useState<string | null>(null);
  const trashLabel = t('filesView.trash');

  const fail = (error: unknown) => {
    if (error instanceof SharingUnavailable) return alertError(t('filesView.shareUnavailable'));
    const code = problemCode(uploadProblem(error));
    if (code === 'already_exists') return alertError(t('filesView.alreadyExists'));
    if (code === 'invalid_path') return alertError(t('filesView.invalidName'));
    if (code === 'not_found') return alertError(t('filesView.fileNotFound'));
    alertError(t('common.actionFailed'));
  };

  /** Name of the local copy: the entry's (without its trash stamp), `.zip` for a folder. */
  const localName = (entry: Pick<FileEntry, 'path' | 'type'>) => {
    const name = entry.path
      ? originalName(baseName(entry.path))
      : (ownerName ?? t('filesView.title'));
    const shown = entry.path === TRASH_FOLDER ? trashLabel : name;
    return entry.type === 'directory' ? `${shown}.zip` : shown;
  };

  const share = (entry: Pick<FileEntry, 'path' | 'type'>) => {
    if (busy) return;
    const name = localName(entry);
    setBusy(t('filesView.downloading', { name }));
    void (async () => {
      try {
        const file = await downloadToCache(workspaceId, entry.path, name, {
          onProgress: (fraction) =>
            setBusy(
              fraction === null
                ? t('filesView.downloading', { name })
                : t('filesView.downloadingPercent', { name, percent: Math.round(fraction * 100) }),
            ),
        });
        setBusy(null);
        await shareLocalFile(file, name);
      } catch (error) {
        setBusy(null);
        fail(error);
      }
    })();
  };

  const upload = () => {
    if (busy) return;
    void (async () => {
      const picked = await DocumentPicker.getDocumentAsync({
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (picked.canceled || picked.assets.length === 0) return;
      mutations.upload.mutate(
        {
          dir,
          assets: picked.assets,
          onFile: (asset) => setBusy(t('filesView.uploading', { name: asset.name })),
        },
        { onSettled: () => setBusy(null), onError: fail },
      );
    })().catch(fail);
  };

  const newFolder = () =>
    prompt.ask({
      title: t('filesView.newFolder'),
      placeholder: t('filesView.folderName'),
      confirmLabel: t('filesView.create'),
      onSubmit: (value) => {
        const name = validName(value);
        if (!name) return alertError(t('filesView.invalidName'));
        mutations.mkdir.mutate(joinPath(dir, name), { onError: fail });
      },
    });

  const rename = (entry: FileEntry) =>
    prompt.ask({
      title: t('filesView.rename'),
      initial: entry.name,
      placeholder: t('filesView.newName'),
      confirmLabel: t('filesView.rename'),
      onSubmit: (value) => {
        const name = validName(value);
        if (!name) return alertError(t('filesView.invalidName'));
        if (name === entry.name) return;
        const to = joinPath(parentOf(entry.path), name);
        mutations.move.mutate(
          { from: entry.path, to },
          { onSuccess: () => onRenamed?.(to), onError: fail },
        );
      },
    });

  const remove = (entry: FileEntry) => {
    const name = displayName(entry.path, trashLabel);
    const purge = isInTrash(entry.path);
    void confirm(
      t(purge ? 'filesView.confirmPurge' : 'filesView.confirmTrash', { name }),
      t(purge ? 'filesView.confirmPurgeHint' : 'filesView.confirmTrashHint'),
      { label: t(purge ? 'filesView.purge' : 'filesView.toTrash'), destructive: true },
    ).then((ok) => {
      if (!ok) return;
      mutations.remove.mutate(entry.path, {
        onSuccess: () => onDeleted?.(entry.path),
        onError: fail,
      });
    });
  };

  const openEntryMenu = (entry: FileEntry, { move = true } = {}) => {
    const folder = entry.type === 'directory';
    const options: MenuOption[] = [
      {
        label: t(folder ? 'filesView.shareZip' : 'filesView.share'),
        icon: ShareIcon,
        onPress: () => share(entry),
      },
    ];
    // The trash itself stays where it is.
    if (entry.path !== TRASH_FOLDER) {
      options.push({ label: t('filesView.rename'), icon: Pencil, onPress: () => rename(entry) });
      if (move) {
        options.push({
          label: t(parentOf(entry.path) === TRASH_FOLDER ? 'filesView.restore' : 'filesView.move'),
          icon: FolderInput,
          onPress: () =>
            router.push({
              pathname: '/files/[workspaceId]/move',
              params: { workspaceId, from: entry.path },
            }),
        });
      }
      options.push({
        label: t(isInTrash(entry.path) ? 'filesView.purge' : 'filesView.toTrash'),
        icon: Trash2,
        destructive: true,
        onPress: () => remove(entry),
      });
    }
    openOptions({ title: displayName(entry.path, trashLabel), options });
  };

  const openFolderMenu = () => {
    const options: MenuOption[] = [];
    // Nothing is added to the trash but by deleting.
    if (!isInTrash(dir)) {
      options.push(
        { label: t('filesView.upload'), icon: Upload, onPress: upload },
        { label: t('filesView.newFolder'), icon: FolderPlus, onPress: newFolder },
      );
    }
    options.push({
      label: t('filesView.downloadFolder'),
      icon: Download,
      onPress: () => share({ path: dir, type: 'directory' }),
    });
    openOptions({
      title: dir ? displayName(dir, trashLabel) : (ownerName ?? t('filesView.title')),
      options,
    });
  };

  return { openEntryMenu, openFolderMenu, share, upload, busy, element: prompt.element };
}
