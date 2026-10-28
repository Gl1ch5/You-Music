// Sleep timer: a player button (UI slot), a settings screen, its own storage and player control.
// `mod` is the scoped API object (see docs/mods.md).
const { h } = mod.ui;
const CHOICES = [15, 30, 45, 60, 90];
let timer = null;
let endsAt = 0;
let afterTrack = false;

mod.icons.override({
  moon: '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/><path d="M17 3.5v3M15.5 5h3"/>',
});

function stop() {
  clearTimeout(timer);
  timer = null;
  afterTrack = false;
}

function start(minutes) {
  stop();
  endsAt = Date.now() + minutes * 60_000;
  timer = setTimeout(
    mod.safe(() => {
      timer = null;
      mod.player.pause();
      mod.ui.toast('Таймер сна: пауза');
    }),
    minutes * 60_000,
  );
  mod.ui.toast(`Пауза через ${minutes} мин`);
}

mod.on('trackChanged', () => {
  if (!afterTrack) return;
  afterTrack = false;
  mod.player.pause();
  mod.ui.toast('Таймер сна: трек закончился');
});

mod.ui.addPlayerButton({
  id: 'sleep',
  icon: 'moon',
  label: 'Таймер сна',
  onClick() {
    mod.ui.openSheet({
      title: 'Таймер сна',
      render(el, close) {
        const pick = (fn) => () => {
          fn();
          close();
        };
        if (timer || afterTrack) {
          const left = afterTrack ? 'после этого трека' : `через ${Math.ceil((endsAt - Date.now()) / 60_000)} мин`;
          el.append(h('div.item', null, h('div.item-main', null, `Пауза ${left}`)));
          el.append(h('button.btn.block', { onclick: pick(stop) }, 'Отменить таймер'));
          return;
        }
        for (const m of CHOICES) el.append(h('div.item', { onclick: pick(() => start(m)) }, `${m} минут`));
        el.append(
          h('div.item', { onclick: pick(() => {
            stop();
            afterTrack = true;
            mod.ui.toast('Пауза после текущего трека');
          }) }, 'После текущего трека'),
        );
      },
    });
  },
});

mod.ui.addSettingsScreen({
  id: 'settings',
  title: 'Таймер по умолчанию',
  render(el) {
    const info = h('div.muted', { style: { margin: 'var(--s-2) 0' } }, '');
    el.append(h('div', null, 'Запускать таймер автоматически при открытии приложения:'), info);
    mod.storage.get('autoMinutes', 0).then((current) => {
      info.textContent = current ? `Сейчас: ${current} мин` : 'Сейчас: выключено';
      for (const m of [0, ...CHOICES]) {
        el.append(h('button.chip' + (m === current ? '.active' : ''), {
          style: { margin: '4px' },
          onclick: async () => {
            await mod.storage.set('autoMinutes', m);
            info.textContent = m ? `Сейчас: ${m} мин` : 'Сейчас: выключено';
          },
        }, m ? `${m} мин` : 'Выкл'));
      }
    });
  },
});

mod.storage.get('autoMinutes', 0).then((m) => m && start(m));
