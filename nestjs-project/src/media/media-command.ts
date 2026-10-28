import { spawn } from 'node:child_process';

export class MediaCommandError extends Error {
  constructor(
    public readonly command: string,
    reason: string,
    public readonly stderr: string,
  ) {
    super(stderr ? `${command} ${reason}: ${stderr}` : `${command} ${reason}`);
    this.name = 'MediaCommandError';
  }
}

/**
 * Runs a binary with an explicit argument array (no shell) and resolves its
 * stdout. Settles only after the process has exited, so a timed-out command
 * is never left running.
 */
export function runMediaCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new MediaCommandError(command, `failed to start`, error.message));
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const errorOutput = Buffer.concat(stderr).toString('utf8').trim();
      if (timedOut) {
        reject(
          new MediaCommandError(
            command,
            `timed out after ${timeoutMs}ms`,
            errorOutput,
          ),
        );
      } else if (code !== 0) {
        reject(
          new MediaCommandError(
            command,
            `exited with ${code ?? signal}`,
            errorOutput,
          ),
        );
      } else {
        resolve(Buffer.concat(stdout).toString('utf8'));
      }
    });
  });
}
