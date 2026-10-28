import { defineRoute, goBack } from '../app/router';
import { h, replaceChildren } from '../core/dom';
import { busy } from '../core/busy';
import { server, setServerProxy, signIn, signOut, syncNow } from '../services/server';
import { appBar, button, listItem, switchControl, watchScroll } from '../ui/components';
import { toast } from '../ui/toast';

/** What the account gives, in plain words — shown here and in the first-launch setup. */
export const SERVER_PERKS: [string, string, string][] = [
  ['cloud', 'Ваша музыка не потеряется', 'Лайки, плейлисты и история хранятся в облаке. Новый телефон или переустановка — вошли, и всё на месте.'],
  ['sparkle', 'Умные рекомендации', 'Нейросеть помогает подбирать музыку под ваш вкус — до 50 запросов в день. Ничего настраивать и платить не нужно.'],
  ['shield', 'Бесплатный прокси', 'Если YouTube тормозит или не открывается — включите прокси, и музыка пойдёт через наш сервер.'],
];

export function perksList(): HTMLElement {
  return h('div', null, SERVER_PERKS.map(([icon, title, sub]) => listItem({ icon, title, sub })));
}

/** Login/registration form; [done] runs after a successful sign-in. */
export function authForm(done?: () => void): HTMLElement {
  let register = true;
  const login = h('input.textfield', { attrs: { placeholder: 'Логин (латиница и цифры)', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false' } });
  const pass = h('input.textfield', { attrs: { placeholder: 'Пароль (от 6 символов)', type: 'password', autocomplete: 'new-password' } });
  const submit = button('Создать аккаунт', () => void go(), { cls: 'block' });
  const switchMode = h('button.link-btn.small.muted', { attrs: { type: 'button' } });
  const render = () => {
    submit.querySelector('span')?.replaceChildren(register ? 'Создать аккаунт' : 'Войти');
    if (!submit.querySelector('span')) submit.textContent = register ? 'Создать аккаунт' : 'Войти';
    switchMode.textContent = register ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Создать';
    pass.setAttribute('autocomplete', register ? 'new-password' : 'current-password');
  };
  switchMode.onclick = () => {
    register = !register;
    render();
  };
  const go = async () => {
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      await busy(signIn(login.value.trim(), pass.value, register));
      pass.value = '';
      toast(register ? 'Аккаунт создан, библиотека синхронизирована' : 'Вы вошли, библиотека синхронизирована', { icon: 'check' });
      done?.();
    } catch (e) {
      toast((e as Error).message, { icon: 'alert' });
    } finally {
      submit.disabled = false;
    }
  };
  pass.addEventListener('keydown', (e) => e.key === 'Enter' && void go());
  render();
  return h('div.stack', { style: { gap: 'var(--s-2)' } }, login, pass, submit, switchMode);
}

function ago(ts: number): string {
  if (!ts) return 'ещё не было';
  const min = Math.round((Date.now() - ts) / 60_000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} мин назад`;
  return new Date(ts).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

defineRoute('account', ({ scope }) => {
  const screen = h('div.screen');
  const bar = appBar({ title: 'Аккаунт', back: goBack });
  watchScroll(screen, bar);
  const body = h('div');
  scope.effect(() => {
    const s = server.value;
    if (!s.signedIn) {
      replaceChildren(body, h('div.pad.small.muted', null, 'Аккаунт необязателен — приложение работает и без него. С ним появится:'), perksList(), h('div.pad', null, authForm()));
      return;
    }
    replaceChildren(
      body,
      listItem({ icon: 'user', title: s.login ?? '', sub: 'Вы вошли' }),
      listItem({
        icon: 'cloud',
        title: 'Синхронизация',
        sub: s.syncing ? 'Синхронизируем…' : s.syncError ? `Ошибка: ${s.syncError}` : `Последняя: ${ago(s.syncedAt)} · происходит сама после изменений`,
        trailing: button('Сейчас', () => void busy(syncNow()).catch((e) => toast((e as Error).message, { icon: 'alert' })), { cls: 'ghost' }),
      }),
      listItem({ icon: 'sparkle', title: 'Нейросеть в рекомендациях', sub: s.ai.enabled ? `Осталось сегодня: ${s.ai.left} из ${s.ai.limit}` : 'Временно недоступны' }),
      s.proxyAvailable
        ? listItem({
            icon: 'shield',
            title: 'Бесплатный прокси',
            sub: 'Музыка идёт через сервер You Music — помогает, если YouTube тормозит. При включённом VPN не используется.',
            trailing: switchControl(s.proxyOn, (on) => void setServerProxy(on).catch((e) => toast((e as Error).message, { icon: 'alert' }))),
          })
        : h('div'),
      h('div.pad', { style: { marginTop: 'var(--s-3)' } }, button('Выйти', () => void signOut(), { cls: 'ghost block' })),
    );
  });
  screen.append(bar, h('div.page-head', null, h('h1.h1', null, 'Аккаунт')), body);
  return screen;
});
