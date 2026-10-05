import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statfsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { backup, type DatabaseSync } from 'node:sqlite';
import { HARMONY_VERSION, type UpdateSnapshotInfo } from '@harmony/shared';
import type { Config } from '../config.ts';
import { HttpError } from '../http/errors.ts';
import type { ServerLogService } from '../log/service.ts';
import type { SettingsService } from '../settings/service.ts';

/** Retained snapshots live in this directory under the data directory. */
export const UPDATE_SNAPSHOT_DIR = 'update-backups';
const SNAPSHOT_EXTENSION = '.db';
/** The most output the panel keeps from one apply, in characters. */
const LOG_LIMIT = 16 * 1024;
/** Free space a snapshot must leave untouched beyond the database's own size. */
const DISK_HEADROOM_BYTES = 16 * 1024 * 1024;

/** The apply button's state, as the Update tab reads it. */
export interface UpdateApplyState {
  /** True while the command is running. */
  applying: boolean;
  /** The tail of the running or last apply's output. */
  log: string;
  /** True when the last apply ended in failure. */
  failed: boolean;
}

export interface UpdateApplier {
  state(): UpdateApplyState;
  /** The retained snapshots, newest first. */
  snapshots(): UpdateSnapshotInfo[];
  /**
   * Starts an apply: optionally snapshots the database, then runs the configured
   * command. Refuses with an `HttpError` when no command is set, when one is already
   * running, or when the snapshot cannot be written, so the route answers with a
   * real status rather than a failure reported after the fact. Resolves once the
   * command is running, not when it finishes.
   */
  apply(options: { backup: boolean }): Promise<void>;
}

export interface UpdateApplierDeps {
  sqlite: DatabaseSync;
  config: Config;
  settings: Pick<SettingsService, 'getUpdateBackupRetention'>;
  serverLog: ServerLogService;
  /**
   * Called once the command exits cleanly. This is where the process restarts: the
   * app does not ask systemd (it has no privilege to), it exits and lets its
   * supervisor bring it back, which is also why the same command works under pm2 or
   * Docker's restart policy.
   */
  onSuccess: () => void;
  /** Injected by tests; a real run spawns a shell. */
  spawnImpl?: typeof spawn;
  /** Injected by tests; a real run uses the system clock. */
  now?: () => Date;
}

/** The retained snapshots in `dir`, newest first. A missing directory is empty. */
export function listUpdateSnapshots(dir: string): UpdateSnapshotInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: UpdateSnapshotInfo[] = [];
  for (const name of names) {
    if (!name.endsWith(SNAPSHOT_EXTENSION)) continue;
    try {
      const stats = statSync(join(dir, name));
      if (!stats.isFile()) continue;
      files.push({ filename: name, sizeBytes: stats.size, createdAt: stats.mtime.toISOString() });
    } catch {
      // A file that vanished while listing is simply skipped.
    }
  }
  // The temporary snapshots are gone; only retained ones carry the .db suffix.
  return files.sort((a, b) =>
    a.createdAt === b.createdAt ? b.filename.localeCompare(a.filename) : b.createdAt.localeCompare(a.createdAt),
  );
}

/** Deletes all but the newest `keep` snapshots. Returns how many were removed. */
export function pruneUpdateSnapshots(dir: string, keep: number): number {
  const files = listUpdateSnapshots(dir);
  let removed = 0;
  for (const file of files.slice(Math.max(0, keep))) {
    rmSync(join(dir, file.filename), { force: true });
    removed++;
  }
  return removed;
}

/**
 * The manual "Update now" path. It never runs on its own: the owner presses a
 * button, which optionally snapshots the database and then runs the command they
 * configured in `HARMONY_UPDATE_COMMAND`. The command does the pulling and
 * building; this module only guards against two running at once, keeps a snapshot
 * as the safety net a code rollback cannot be, and restarts the process on success.
 */
export function createUpdateApplier(deps: UpdateApplierDeps): UpdateApplier {
  const spawnImpl = deps.spawnImpl ?? spawn;
  const now = deps.now ?? (() => new Date());
  const dir = join(deps.config.dataDir, UPDATE_SNAPSHOT_DIR);

  let applying = false;
  let log = '';
  let failed = false;

  function appendLog(chunk: string): void {
    log += chunk;
    if (log.length > LOG_LIMIT) log = log.slice(log.length - LOG_LIMIT);
  }

  /** The database plus its write-ahead log: the bytes a snapshot has to hold. */
  function databaseBytes(): number {
    let total = 0;
    for (const suffix of ['', '-wal']) {
      try {
        total += statSync(`${deps.config.dbFile}${suffix}`).size;
      } catch {
        // A missing WAL is normal: it only exists between writes.
      }
    }
    return total;
  }

  function freeBytes(): number {
    const stats = statfsSync(deps.config.dataDir);
    return Number(stats.bavail) * Number(stats.bsize);
  }

  /**
   * SQLite's online backup, the same call the manual backup service uses: it copies
   * the live database page by page and restarts on a concurrent write, so the file
   * is one consistent point in time. Uploaded blobs are content-addressed and never
   * rewritten, so they are not at risk during an update and are not copied.
   */
  async function takeSnapshot(): Promise<string> {
    mkdirSync(dir, { recursive: true });
    if (freeBytes() < databaseBytes() + DISK_HEADROOM_BYTES) {
      throw new HttpError(
        409,
        'disk_full',
        'Not enough free disk space for a snapshot. Free some space, raise the limit, or use Update without backup.',
      );
    }
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `harmony-${HARMONY_VERSION}-${stamp}${SNAPSHOT_EXTENSION}`);
    await backup(deps.sqlite, path);
    pruneUpdateSnapshots(dir, deps.settings.getUpdateBackupRetention());
    return path;
  }

  /** Runs the command as a tracked child and settles the apply state on its exit. */
  function spawnCommand(command: string): void {
    appendLog(`Running: ${command}\n`);
    deps.serverLog.info('update_started', 'Update command started');

    let child: ChildProcess;
    try {
      // A shell so the owner can write a command line, not a single binary path. It
      // is deliberately not detached: under systemd a detached child is still in the
      // service's cgroup and would be killed on the restart anyway, and waiting on
      // this one is what tells failure from success before deciding to exit.
      child = spawnImpl('/bin/sh', ['-c', command], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      applying = false;
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      appendLog(`Could not start the command: ${message}\n`);
      deps.serverLog.error('update_spawn_failed', message);
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => appendLog(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => appendLog(chunk.toString()));
    child.on('error', (error: Error) => appendLog(`Could not start the command: ${error.message}\n`));
    child.on('close', (code) => {
      if (code === 0) {
        appendLog('Update succeeded. Restarting…\n');
        applying = false;
        deps.serverLog.info('update_applied', 'Update command finished; restarting');
        // The process exits here; the supervisor starts the new build.
        deps.onSuccess();
        return;
      }
      applying = false;
      failed = true;
      appendLog(`The command exited with code ${code ?? 'null'}.\n`);
      deps.serverLog.error('update_failed', `Update command exited with code ${code ?? 'null'}`);
    });
  }

  return {
    state() {
      return { applying, log, failed };
    },

    snapshots() {
      return listUpdateSnapshots(dir);
    },

    async apply({ backup: wantBackup }) {
      const command = deps.config.updateCommand;
      if (command === null) {
        throw new HttpError(409, 'update_disabled', 'No update command is configured on this instance.');
      }
      if (applying) {
        throw new HttpError(409, 'update_in_progress', 'An update is already running.');
      }
      applying = true;
      failed = false;
      log = '';

      // The snapshot is awaited, so a full disk is refused with a real 409 rather
      // than turning up as a failure after the command has already started.
      if (wantBackup) {
        try {
          const path = await takeSnapshot();
          appendLog(`Snapshot written to ${basename(path)}.\n`);
          deps.serverLog.info('update_snapshot', basename(path));
        } catch (error) {
          applying = false;
          failed = true;
          const message = error instanceof Error ? error.message : String(error);
          appendLog(`${message}\n`);
          deps.serverLog.error('update_snapshot_failed', message);
          throw error;
        }
      } else {
        appendLog('Updating without a database snapshot.\n');
      }

      spawnCommand(command);
    },
  };
}
