import { HARMONY_VERSION, isNewerVersion, parseVersionFile, type UpdateStatus } from '@harmony/shared';
import type { SettingsService } from '../settings/service.ts';

/** How long a version fetch may take before it is abandoned. */
const FETCH_TIMEOUT_MS = 10_000;
/** Wait after startup before the first automatic check, so boot is never held up. */
const AUTO_FIRST_DELAY_MS = 60_000;
/** How often the automatic check runs once it is switched on. */
const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateServiceDeps {
  settings: Pick<SettingsService, 'getUpdateCheck'>;
  /** The constants file to read the newest version from, or null when disabled. */
  sourceUrl: string | null;
  /** Called when a check finds a newer release than the last one it announced. */
  notify?: (status: UpdateStatus) => void;
  log?: (message: string, detail?: Record<string, unknown>) => void;
  /** Injected by tests; a real run uses the global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Test overrides for the automatic schedule. */
  autoFirstDelayMs?: number;
  autoIntervalMs?: number;
  fetchTimeoutMs?: number;
}

export interface UpdateService {
  /** The last known status. Reads the auto-check toggle fresh each time. */
  status(): UpdateStatus;
  /** Runs a check now and returns the new status. Concurrent calls share one run. */
  check(): Promise<UpdateStatus>;
  /** Re-reads the toggle and (re)schedules the automatic check. */
  refresh(): void;
  start(): void;
  stop(): void;
}

/**
 * Compares this instance's version with the newest on its update branch. The
 * branch file is a plain constants file, so the check is a single small GET with
 * no API key and no rate limit to manage.
 *
 * Nothing is announced until a check actually finds a newer release, and each
 * release is announced once: a restart, or a second check on the same version,
 * does not repeat the notice. The whole thing is off unless the owner switches
 * the daily check on, or presses the button.
 */
export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const autoFirstDelayMs = deps.autoFirstDelayMs ?? AUTO_FIRST_DELAY_MS;
  const autoIntervalMs = deps.autoIntervalMs ?? AUTO_INTERVAL_MS;
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;

  let state: UpdateStatus = {
    running: HARMONY_VERSION,
    latest: null,
    available: false,
    checkedAt: null,
    error: null,
    autoCheck: false,
    enabled: deps.sourceUrl !== null,
  };
  /** The latest version already handed to `notify`, so it is announced only once. */
  let announced: string | null = null;
  let inFlight: Promise<UpdateStatus> | null = null;
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  function status(): UpdateStatus {
    // The toggle and the configured source are read fresh, so the panel is never
    // stale even if the schedule has not fired since they changed.
    return { ...state, autoCheck: deps.settings.getUpdateCheck(), enabled: deps.sourceUrl !== null };
  }

  async function runCheck(): Promise<UpdateStatus> {
    const url = deps.sourceUrl;
    if (url === null) return status();

    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'text/plain' },
        signal: AbortSignal.timeout(fetchTimeoutMs),
      });
      if (!response.ok) throw new Error(`the source answered ${response.status}`);
      const latest = parseVersionFile(await response.text());
      if (latest === null) throw new Error('the source carried no version');

      state = {
        ...state,
        latest,
        available: isNewerVersion(latest, state.running),
        checkedAt: now().toISOString(),
        error: null,
      };
    } catch (cause) {
      // A failed check keeps the last known answer; a blip must not look like
      // "up to date". The reason is surfaced for the panel.
      state = { ...state, error: cause instanceof Error ? cause.message : String(cause) };
      deps.log?.('update check failed', { error: state.error });
      return status();
    }

    if (state.available && state.latest !== null && state.latest !== announced) {
      announced = state.latest;
      deps.notify?.(status());
    }
    return status();
  }

  function check(): Promise<UpdateStatus> {
    if (inFlight) return inFlight;
    inFlight = runCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function clearTimers(): void {
    if (firstTimer) {
      clearTimeout(firstTimer);
      firstTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  function refresh(): void {
    clearTimers();
    if (deps.sourceUrl === null || !deps.settings.getUpdateCheck()) return;
    // A first check after a short delay, then one a day. Both are unref'd so a
    // scheduled check never keeps the process alive on its own.
    firstTimer = setTimeout(() => {
      firstTimer = null;
      void check();
      intervalTimer = setInterval(() => void check(), autoIntervalMs);
      (intervalTimer as { unref?: () => void }).unref?.();
    }, autoFirstDelayMs);
    (firstTimer as { unref?: () => void }).unref?.();
  }

  return {
    status,
    check,
    refresh,
    start() {
      refresh();
    },
    stop() {
      clearTimers();
    },
  };
}
