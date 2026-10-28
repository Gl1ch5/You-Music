import '@fontsource-variable/inter/index.css';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';

import './screens/home';
import './screens/search';
import './screens/collection';
import './screens/library';
import './screens/catalog';
import './screens/offline';
import './screens/settings';
import './screens/themeEditor';
import './screens/import';
import './screens/network';
import './screens/account';

import { goBack } from './app/router';
import { mountShell } from './app/shell';
import { call, onNative } from './bridge/bridge';
import { app } from './core/store';
import { useIconSet } from './design/icons';
import { loadMods } from './mods/host';
import { closePlayer, mountFullPlayer } from './player/full';
import { mountMiniPlayer } from './player/mini';
import { uiBus } from './services/events';
import { initLibrary, refreshLibrary } from './services/library';
import { initPlayback, restorePlayer } from './services/playback';
import { loadSettings } from './services/settings';
import { loadDislikes } from './services/dislikes';
import { loadWaves } from './services/waves';
import { refreshAiConfig } from './services/ai';
import { initDeepLinks } from './services/deeplink';
import { initBackup } from './services/backup';
import { initServer } from './services/server';
import { runOnboarding } from './ui/onboarding';
import { initUpdates } from './services/updates';
import { loadThemes } from './theme/engine';
import { handleBack, onBack } from './ui/back';
import { initRowMarkers } from './ui/components';

function applyInsets(i: { top: number; bottom: number }): void {
  app.insets.value = { ...app.insets.peek(), ...i };
  document.documentElement.style.setProperty('--safe-top', `${i.top}px`);
  document.documentElement.style.setProperty('--safe-bottom', `${i.bottom}px`);
}

async function boot(): Promise<void> {
  useIconSet('graphite');
  const hello = await call('hello');
  app.version.value = { app: hello.appVersion, extractor: hello.extractorVersion };
  app.online.value = hello.online;
  applyInsets(hello.insets);
  onNative('insets', applyInsets);
  onNative('network', ({ online }) => {
    app.online.value = online;
    uiBus.emit('online', { online });
  });

  await loadSettings();
  await loadThemes(app.settings.peek().themeId);

  initLibrary();
  initPlayback();
  initRowMarkers();

  const root = document.getElementById('app')!;
  mountShell(root, [mountMiniPlayer(), mountFullPlayer()]);

  // Back: sheets and the player register their own handlers; then the tab stack; then leave the app.
  onBack(() => goBack());
  onNative('back', () => {
    if (!handleBack()) call('moveToBack');
  });
  window.addEventListener('keydown', (e) => e.key === 'Escape' && (handleBack() || closePlayer()));

  await Promise.all([refreshLibrary().catch(console.error), restorePlayer(), refreshAiConfig(), loadDislikes(), loadWaves()]);
  initUpdates();
  initServer();
  initDeepLinks();
  app.ready.value = true;
  document.documentElement.classList.add('ready');
  // The restore offer waits for the first-launch setup so the two never overlap.
  runOnboarding().catch(console.error).finally(initBackup);

  // Mods load last so a broken mod can never block the core UI.
  loadMods(hello.appVersion).catch(console.error);
}

boot().catch((e) => {
  console.error(e);
  document.body.textContent = `Не удалось запустить интерфейс: ${e?.message ?? e}`;
});
