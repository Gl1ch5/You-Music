import { call } from '../bridge/bridge';
import { app, defaultSettings, type Settings } from '../core/store';

const KEY = 'settings';

export async function loadSettings(): Promise<void> {
  const raw = await call('kvGet', { key: KEY }).catch(() => null);
  let stored: Partial<Settings>;
  try {
    stored = raw ? JSON.parse(raw) : {};
  } catch {
    stored = {};
  }
  // "neuro" was a separate mode; the model is now part of every mode.
  if ((stored.waveMode as string) === 'neuro') stored.waveMode = 'mix';
  app.settings.value = { ...defaultSettings, ...stored };
  applyMotion();
}

/** Persists settings; native reads the same JSON for stream/download quality and cache size. */
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  app.settings.value = { ...app.settings.peek(), ...patch };
  applyMotion();
  await call('kvSet', { key: KEY, value: JSON.stringify(app.settings.peek()) });
}

function applyMotion(): void {
  const m = app.settings.peek().motion;
  if (m === 'system') delete document.documentElement.dataset.motion;
  else document.documentElement.dataset.motion = m;
}
