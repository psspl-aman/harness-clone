import { describe, expect, it } from 'vitest';
import { isWithin, normalizePath } from '../src/lib/paths';

const isWin = process.platform === 'win32';

describe('normalizePath', () => {
  it('rejects relative paths', () => {
    expect(normalizePath('relative/path')).toBeNull();
  });

  it.skipIf(isWin)('keeps the POSIX root and strips trailing separators elsewhere', () => {
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/a/b/')).toBe('/a/b');
    expect(normalizePath('/a/../b')).toBe('/b');
  });

  it.runIf(isWin)('keeps a drive root as C:\\ (C: alone means cwd on drive C)', () => {
    expect(normalizePath('C:\\')).toBe('C:\\');
    expect(normalizePath('C:/')).toBe('C:\\');
    expect(normalizePath('C:\\Users\\')).toBe('C:\\Users');
    expect(normalizePath('C:\\Users\\..\\')).toBe('C:\\');
  });

  it.runIf(isWin)('isWithin works against a drive root', () => {
    expect(isWithin('C:\\', 'C:\\Users')).toBe(true);
    expect(isWithin('C:\\', 'D:\\x')).toBe(false);
  });
});
