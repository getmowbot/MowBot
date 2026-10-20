import type { FileEntry } from '@mowbot/contract';
import { describe, expect, it } from 'vitest';
import { en } from '../i18n/en';
import { fr } from '../i18n/fr';
import {
  baseName,
  canMoveInto,
  contentUrl,
  displayName,
  downloadUrl,
  fileKind,
  formatSize,
  isInTrash,
  joinPath,
  localFileName,
  mimeTypeFor,
  moveTarget,
  originalName,
  parentOf,
  pathSegments,
  previewKind,
  sortEntries,
  textChunks,
  validName,
} from './files';

const entry = (path: string, type: FileEntry['type'] = 'file'): FileEntry => ({
  name: baseName(path),
  path,
  type,
  size: 0,
  modifiedAt: new Date(0).toISOString(),
});

describe('workspace paths', () => {
  it('joins, splits and goes up', () => {
    expect(joinPath('', 'outputs')).toBe('outputs');
    expect(joinPath('outputs/reports', 'q3.md')).toBe('outputs/reports/q3.md');
    expect(parentOf('outputs/reports/q3.md')).toBe('outputs/reports');
    expect(parentOf('outputs')).toBe('');
    expect(parentOf('')).toBe('');
    expect(baseName('outputs/reports/q3.md')).toBe('q3.md');
    expect(baseName('outputs')).toBe('outputs');
    expect(pathSegments('')).toEqual([]);
    expect(pathSegments('a/b/c')).toEqual(['a', 'b', 'c']);
  });

  it('knows the trash', () => {
    expect(isInTrash('.trash')).toBe(true);
    expect(isInTrash('.trash/2026-10-20T08-15-02-123Z-a.md')).toBe(true);
    expect(isInTrash('.trashy')).toBe(false);
    expect(isInTrash('outputs')).toBe(false);
  });

  it('shows trashed entries under their original name', () => {
    expect(originalName('2026-10-20T08-15-02-123Z-report.md')).toBe('report.md');
    expect(originalName('report.md')).toBe('report.md');
    expect(displayName('.trash', 'Corbeille')).toBe('Corbeille');
    expect(displayName('.trash/2026-10-20T08-15-02-123Z-report.md', 'Trash')).toBe('report.md');
    // Deeper in the trash, names are the real ones.
    expect(displayName('.trash/2026-10-20T08-15-02-123Z-old/2026-01-01T00-00-00-000Z-x', 'T')).toBe(
      '2026-01-01T00-00-00-000Z-x',
    );
    expect(displayName('outputs/a.md', 'Trash')).toBe('a.md');
  });

  it('validates typed names', () => {
    expect(validName('  Rapports  ')).toBe('Rapports');
    expect(validName('')).toBeNull();
    expect(validName('   ')).toBeNull();
    expect(validName('..')).toBeNull();
    expect(validName('a/b')).toBeNull();
    expect(validName('a\\b')).toBeNull();
    expect(validName('x'.repeat(256))).toBeNull();
    expect(validName('.env')).toBe('.env');
  });

  it('moves entries, restoring names out of the trash', () => {
    expect(moveTarget('outputs/a.md', 'shared')).toBe('shared/a.md');
    expect(moveTarget('outputs/a.md', '')).toBe('a.md');
    expect(moveTarget('.trash/2026-10-20T08-15-02-123Z-a.md', 'outputs')).toBe('outputs/a.md');
    expect(canMoveInto('outputs/a.md', 'outputs')).toBe(false);
    expect(canMoveInto('outputs/a.md', '')).toBe(true);
    expect(canMoveInto('outputs', 'outputs/sub')).toBe(false);
    expect(canMoveInto('outputs', 'outputs')).toBe(false);
    expect(canMoveInto('outputs', 'outputs2')).toBe(true);
    expect(canMoveInto('a', '')).toBe(false);
  });

  it('lists folders first and the trash last', () => {
    const sorted = sortEntries([
      entry('.trash', 'directory'),
      entry('b.md'),
      entry('shared', 'directory'),
      entry('a.md'),
      entry('bots', 'directory'),
    ]);
    expect(sorted.map((e) => e.path)).toEqual(['shared', 'bots', 'b.md', 'a.md', '.trash']);
  });
});

describe('file kinds', () => {
  it('picks an icon kind from the extension', () => {
    expect(fileKind('README.md')).toBe('markdown');
    expect(fileKind('notes.TXT')).toBe('text');
    expect(fileKind('data.csv')).toBe('sheet');
    expect(fileKind('app.tsx')).toBe('code');
    expect(fileKind('photo.JPEG')).toBe('image');
    expect(fileKind('doc.pdf')).toBe('pdf');
    expect(fileKind('song.mp3')).toBe('audio');
    expect(fileKind('clip.mp4')).toBe('video');
    expect(fileKind('backup.zip')).toBe('archive');
    expect(fileKind('Makefile')).toBe('other');
    expect(fileKind('.env')).toBe('other');
  });

  it('decides what can be previewed', () => {
    expect(previewKind('a.md', 10)).toBe('markdown');
    expect(previewKind('a.json', 10)).toBe('text');
    expect(previewKind('a.csv', 10)).toBe('text');
    // Big text is still shown (its beginning).
    expect(previewKind('server.log', 500 * 1024 ** 2)).toBe('text');
    expect(previewKind('a.png', 1024)).toBe('image');
    expect(previewKind('a.png', 30 * 1024 ** 2)).toBeNull();
    expect(previewKind('a.pdf', 1024)).toBe('pdf');
    expect(previewKind('a.xlsx', 10)).toBeNull();
    expect(previewKind('a.mp4', 10)).toBeNull();
  });

  it('gives the share sheet a MIME type and a safe name', () => {
    expect(mimeTypeFor('a.pdf')).toBe('application/pdf');
    expect(mimeTypeFor('a.PNG')).toBe('image/png');
    expect(mimeTypeFor('a.unknown')).toBe('application/octet-stream');
    expect(localFileName('a/b:c.md')).toBe('a_b_c.md');
    expect(localFileName('  ', 'outputs.zip')).toBe('outputs.zip');
  });
});

describe('sizes', () => {
  it('formats in French and English', () => {
    expect(formatSize(512, fr.filesView.units, 'fr')).toBe('512 o');
    expect(formatSize(1536, en.filesView.units, 'en')).toBe('1.5 KB');
    expect(formatSize(1536, fr.filesView.units, 'fr')).toBe('1,5 Ko');
    expect(formatSize(20 * 1024 ** 2, en.filesView.units, 'en')).toBe('20 MB');
    expect(formatSize(3 * 1024 ** 3, en.filesView.units, 'en')).toBe('3.0 GB');
    expect(formatSize(5 * 1024 ** 5, en.filesView.units, 'en')).toBe('5,120 TB');
  });
});

describe('previews', () => {
  it('cuts long text into chunks of lines', () => {
    expect(textChunks('')).toEqual(['']);
    expect(textChunks('a\nb\nc', 2)).toEqual(['a\nb', 'c']);
    expect(textChunks('a\nb', 2)).toEqual(['a\nb']);
  });

  it('builds hub URLs', () => {
    expect(contentUrl('http://hub:8787', 'ws-1', 'outputs/a b.md')).toBe(
      'http://hub:8787/api/v1/workspaces/ws-1/files/content?path=outputs%2Fa%20b.md',
    );
    expect(downloadUrl('http://hub:8787', 'x+y')).toBe('http://hub:8787/api/v1/downloads/x%2By');
  });
});
