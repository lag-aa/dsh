/**
 * Run one git command inside a repository.
 *
 * A copy of the runner the workspace-git plugin uses, kept here rather than
 * imported: the two packages are installed independently and neither may depend
 * on the other being present.
 *
 * Output is redirected into temporary files rather than pipes because the DSH
 * Windows sandbox refuses a piped child (`spawn EPERM`), while a file-redirected
 * child works both inside and outside it. The size cap is checked after the read,
 * so a runaway command cannot grow the answer without a bound.
 *
 * @module dsh-markdown-diff/git-run
 */

import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Run one git command.
 * @param args - git arguments, without the executable.
 * @param options - working directory, cancellation, and caps.
 * @returns stdout on success, or a typed failure with git's own message.
 */
export async function runGit(args, options) {
  const { cwd, signal, timeoutMs = 10000, maxBytes = 8 * 1024 * 1024, env } = options;
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-markdown-diff-io-'));
  const outPath = join(scratch, 'stdout.txt');
  const errPath = join(scratch, 'stderr.txt');
  let out;
  let err;
  try {
    out = await open(outPath, 'w');
    err = await open(errPath, 'w');
    const started = await new Promise((resolve) => {
      let child;
      try {
        child = spawn('git', args, {
          cwd,
          windowsHide: true,
          stdio: ['ignore', out.fd, err.fd],
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
        });
      } catch (error) {
        resolve({ spawnError: error });
        return;
      }
      const timer = setTimeout(() => {
        child.kill();
        resolve({ timedOut: true, child });
      }, timeoutMs);
      const abort = () => child.kill();
      signal?.addEventListener('abort', abort, { once: true });
      child.once('error', (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve({ spawnError: error });
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve({ code, child });
      });
    });
    if (started.spawnError !== undefined) {
      const code = started.spawnError.code;
      if (code === 'ENOENT') return { ok: false, code: 'git-not-found', message: 'git was not found on PATH' };
      return { ok: false, code: 'git-failed', message: String(started.spawnError.message) };
    }
    await out.close();
    await err.close();
    out = undefined;
    err = undefined;
    const stdout = await readFile(outPath, 'utf8');
    if (started.timedOut === true) {
      return { ok: false, code: 'git-timeout', message: `git ${args.join(' ')} did not finish within ${timeoutMs} ms` };
    }
    if (started.code !== 0) {
      const detail = (await readFile(errPath, 'utf8')).trim() || `git ${args.join(' ')} exited with ${String(started.code)}`;
      return { ok: false, code: 'git-failed', message: detail };
    }
    if (Buffer.byteLength(stdout) > maxBytes) {
      return { ok: false, code: 'git-too-large', message: `git ${args.join(' ')} produced more than ${maxBytes} bytes` };
    }
    return { ok: true, stdout };
  } finally {
    await out?.close().catch(() => {});
    await err?.close().catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
