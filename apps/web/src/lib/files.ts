import { i18n } from '../i18n';
import { api, apiBaseUrl } from './auth';

/** What a file's name says of what it holds (previews, icons). */
export const MARKDOWN = /\.(md|markdown)$/i;
export const TEXT =
  /\.(txt|md|markdown|csv|tsv|log|json|jsonl|ya?ml|toml|ini|env|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|sh|bash|sql|conf)$/i;
export const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/i;
export const AUDIO = /\.(mp3|wav|ogg)$/i;
export const VIDEO = /\.(mp4|webm)$/i;
export const PDF = /\.pdf$/i;

const UNITS = ['kb', 'mb', 'gb', 'tb'] as const;

/** `1,5 Mo` / `1.5 MB` */
export const formatSize = (bytes: number) => {
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

/**
 * Single-use link: the browser downloads it natively (no auth header needed). A folder comes
 * as a zip.
 */
export async function downloadWorkspacePath(workspaceId: string, path: string) {
  const { data, error } = await api.POST('/api/v1/workspaces/{id}/files/download-ticket', {
    params: { path: { id: workspaceId } },
    body: { path },
  });
  if (error || !data) throw error;
  const link = document.createElement('a');
  link.href = `${apiBaseUrl}/api/v1/downloads/${encodeURIComponent(data.ticket)}`;
  link.rel = 'noopener';
  link.click();
}
