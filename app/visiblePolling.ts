'use client';

type VisiblePollingOptions = {
  runImmediately?: boolean;
  refreshOnResume?: boolean;
  initialDelayMs?: number;
  resumeDelayMs?: number | (() => number);
  maxBackoffMs?: number;
};

/**
 * Poll only while Esprit is visible and refresh once when the app becomes active
 * again. This keeps local integrations current without waking Mail, Mattermost,
 * Calendar, GitHub or the cluster while the native window is in the background.
 */
export const startVisiblePolling = (
  callback: () => unknown | Promise<unknown>,
  intervalMs: number,
  { runImmediately = true, refreshOnResume = true, initialDelayMs = 0, resumeDelayMs = 0, maxBackoffMs = intervalMs * 4 }: VisiblePollingOptions = {},
) => {
  let wasHidden = document.visibilityState !== 'visible';
  let timer: number | undefined;
  let stopped = false;
  let running = false;
  let failures = 0;
  const clear = () => { if (timer !== undefined) window.clearTimeout(timer); timer = undefined; };
  const schedule = (delay: number) => {
    clear();
    if (!stopped && document.visibilityState === 'visible') timer = window.setTimeout(() => { void runIfVisible(); }, delay);
  };
  const runIfVisible = async () => {
    if (stopped || running || document.visibilityState !== 'visible') return;
    running = true;
    try {
      const result = await callback();
      const failed = result && typeof result === 'object' && 'error' in result && Boolean(result.error);
      failures = failed ? Math.min(failures + 1, 4) : 0;
    } catch { failures = Math.min(failures + 1, 4); }
    finally {
      running = false;
      schedule(Math.min(maxBackoffMs, intervalMs * (2 ** failures)));
    }
  };

  const handleVisibilityChange = () => {
    const visible = document.visibilityState === 'visible';
    if (!visible) clear();
    else if (wasHidden) schedule(refreshOnResume ? typeof resumeDelayMs === 'function' ? resumeDelayMs() : resumeDelayMs : intervalMs);
    wasHidden = !visible;
  };

  schedule(runImmediately ? initialDelayMs : intervalMs);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    stopped = true;
    clear();
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
};
