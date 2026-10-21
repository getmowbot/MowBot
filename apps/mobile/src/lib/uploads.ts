import { Directory, File, Paths, UploadType } from 'expo-file-system';
import { localFileName, mimeTypeFor } from './files';
import { api, authHeaders, hubUrl } from './session';

/** Transfers between the phone's files and the hub, past the typed client. */

/**
 * Makes sure the access token held by the session is valid for a few more seconds: native
 * transfers (images, uploads) send it as is and cannot refresh it on a 401 like typed calls do.
 */
export async function freshAuthHeaders(): Promise<Record<string, string>> {
  await api().GET('/api/v1/me');
  return authHeaders();
}

/** Fresh directory under the cache; `slot` is emptied first (its previous files are done). */
export function cacheDirectory(slot: string): Directory {
  const root = new Directory(Paths.cache, slot);
  if (root.exists) root.delete();
  const dir = new Directory(root, String(Date.now()));
  dir.create({ intermediates: true });
  return dir;
}

class UploadFailed extends Error {
  constructor(readonly problem: unknown) {
    super('Upload failed');
  }
}

/**
 * Posts a local file to the hub as one multipart `file` part (plus `fields`), staged first under
 * its real name: the part is named after the local file. Returns the hub's JSON answer.
 */
export async function postFile(
  path: string,
  file: { uri: string; name: string; mimeType?: string | null },
  fields?: Record<string, string>,
): Promise<unknown> {
  const hub = hubUrl();
  if (!hub) throw new Error('No hub');
  const staged = new File(
    cacheDirectory(`mowbot-upload-${Math.random().toString(36).slice(2)}`),
    localFileName(file.name),
  );
  await new File(file.uri).copy(staged);
  const send = async () =>
    staged.upload(`${hub}${path}`, {
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      mimeType: file.mimeType ?? mimeTypeFor(file.name),
      headers: await freshAuthHeaders(),
      ...(fields ? { parameters: fields } : {}),
      sessionType: 'foreground',
    });
  try {
    let result = await send();
    // The token expired mid-way: one more try with a refreshed one.
    if (result.status === 401) result = await send();
    let body: unknown = null;
    try {
      body = JSON.parse(result.body);
    } catch {
      // Not JSON (an empty answer, or not a problem document).
    }
    if (result.status < 200 || result.status >= 300) throw new UploadFailed(body);
    return body;
  } finally {
    if (staged.parentDirectory.parentDirectory.exists)
      staged.parentDirectory.parentDirectory.delete();
  }
}

/** The error to inspect (`fileProblem`) when an upload fails. */
export function uploadProblem(error: unknown): unknown {
  return error instanceof UploadFailed ? error.problem : error;
}
