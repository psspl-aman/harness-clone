import { describe, expect, it } from 'vitest';
import {
  comSpec,
  interactiveShell,
  pathExts,
  ptyCommand,
  shellCommand,
} from '../src/lib/platform';
import { classifyCommand } from '../src/safety/classify';

describe('platform: shellCommand', () => {
  it('uses bash -lc on POSIX', () => {
    expect(shellCommand('npm run build', 'linux')).toEqual({
      file: 'bash',
      args: ['-lc', 'npm run build'],
    });
  });
  it('uses cmd.exe on Windows', () => {
    expect(shellCommand('npm run build', 'win32', { ComSpec: 'C:\\Windows\\cmd.exe' })).toEqual({
      file: 'C:\\Windows\\cmd.exe',
      args: ['/d', '/s', '/c', 'npm run build'],
    });
  });
  it('falls back to cmd.exe when %ComSpec% is unset', () => {
    expect(shellCommand('x', 'win32', {}).file).toBe('cmd.exe');
  });
});

describe('platform: interactiveShell', () => {
  it('honours $SHELL on POSIX', () => {
    expect(interactiveShell('linux', { SHELL: '/bin/zsh' })).toEqual({
      file: '/bin/zsh',
      args: ['-l'],
    });
  });
  it('uses cmd.exe on Windows', () => {
    expect(interactiveShell('win32', {})).toEqual({ file: 'cmd.exe', args: [] });
  });
});

describe('platform: ptyCommand', () => {
  it('passes commands through unchanged on POSIX', () => {
    expect(ptyCommand('/usr/local/bin/claude', ['auth', 'login'], 'linux')).toEqual({
      file: '/usr/local/bin/claude',
      args: ['auth', 'login'],
    });
  });
  it('wraps a .cmd shim through cmd.exe on Windows', () => {
    expect(ptyCommand('C:\\npm\\claude.cmd', ['auth', 'login'], 'win32', {})).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\npm\\claude.cmd', 'auth', 'login'],
    });
  });
  it('wraps an extensionless shim through cmd.exe on Windows', () => {
    expect(ptyCommand('C:\\npm\\claude', ['--version'], 'win32', {}).file).toBe('cmd.exe');
  });
  it('runs a real .exe directly on Windows', () => {
    expect(ptyCommand('C:\\ext\\claude.exe', ['-p'], 'win32', {})).toEqual({
      file: 'C:\\ext\\claude.exe',
      args: ['-p'],
    });
  });
  it('does not double-wrap cmd.exe itself', () => {
    expect(ptyCommand('cmd.exe', ['/c', 'dir'], 'win32', {})).toEqual({
      file: 'cmd.exe',
      args: ['/c', 'dir'],
    });
  });
});

describe('platform: pathExts', () => {
  it('is empty on POSIX', () => {
    expect(pathExts('linux')).toEqual([]);
  });
  it('parses %PATHEXT% on Windows', () => {
    expect(pathExts('win32', { PATHEXT: '.COM;.EXE;.BAT;.CMD' })).toEqual([
      '.com',
      '.exe',
      '.bat',
      '.cmd',
    ]);
  });
  it('defaults when %PATHEXT% is unset', () => {
    expect(pathExts('win32', {})).toContain('.cmd');
  });
});

describe('platform: comSpec', () => {
  it('defaults to cmd.exe', () => {
    expect(comSpec({})).toBe('cmd.exe');
  });
});

describe('safety: Windows-specific commands', () => {
  const ROOT = 'C:\\project';
  it('denies formatting a drive', () => {
    expect(classifyCommand('format C:', ROOT).level).toBe('deny');
    expect(classifyCommand('Format-Volume -DriveLetter C', ROOT).level).toBe('deny');
  });
  it('denies a recursive delete of a drive root', () => {
    expect(classifyCommand('rm -rf C:\\', ROOT).level).toBe('deny');
  });
  it('denies shutting the machine down via PowerShell', () => {
    expect(classifyCommand('Stop-Computer -Force', ROOT).level).toBe('deny');
  });
  it('still allows an ordinary command', () => {
    expect(classifyCommand('npm test', ROOT).level).toBe('allow');
  });
});
