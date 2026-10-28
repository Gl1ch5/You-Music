import { call } from '../bridge/bridge';
import { signal } from '../core/signal';
import { useIconSet } from '../design/icons';
import { builtinThemes, graphite } from './builtin';
import { COLOR_TOKENS, type Theme } from './types';

/** Applies a theme instantly by rewriting CSS variables on :root — no reload, no re-render. */

const CUSTOM_KEY = 'themes.custom';

export const customThemes = signal<Theme[]>([]);
export const activeTheme = signal<Theme>(graphite);

export function allThemes(): Theme[] {
  return [...builtinThemes, ...customThemes.value];
}

export function applyTheme(theme: Theme): void {
  const t = sanitizeTheme(theme);
  const root = document.documentElement.style;
  for (const token of COLOR_TOKENS) root.setProperty(`--${token}`, t.colors[token]);
  root.setProperty('--r-cover', `${t.radius.cover}px`);
  root.setProperty('--r-card', `${t.radius.card}px`);
  root.setProperty('--r-mini', `${t.radius.mini}px`);
  root.setProperty('--font', t.font.family);
  root.setProperty('--fs-title', `${t.font.titleSize}px`);
  root.setProperty('--lh-title', `${Math.round(t.font.titleSize * 1.15)}px`);
  root.setProperty('--u', `${t.spacing.unit}px`);
  root.setProperty('--ease', t.motion.easing);
  root.setProperty('--motion-press', `${t.motion.press}ms`);
  root.setProperty('--motion-base', `${t.motion.base}ms`);
  root.setProperty('--motion-open', `${t.motion.open}ms`);
  root.setProperty('--icon-stroke', String(t.icons.stroke));
  root.setProperty('--dyn-sat', String(t.dynamic.intensity));
  root.setProperty('--dyn-dim', String(t.dynamic.dim));
  root.setProperty('--grain', String(t.grain));
  root.setProperty('--scrim', t.dark ? 'rgb(0 0 0 / 0.55)' : 'rgb(28 29 31 / 0.35)');
  root.setProperty('--cover-edge', t.dark ? 'rgb(255 255 255 / 0.06)' : 'rgb(0 0 0 / 0.06)');
  document.documentElement.dataset.theme = t.dark ? 'dark' : 'light';
  document.documentElement.classList.toggle('glass', !!t.glass);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.colors.bg);
  useIconSet(t.icons.set);
  activeTheme.value = t;
  call('setSystemBars', { light: !t.dark }).catch(() => undefined);
}

export async function loadThemes(themeId: string): Promise<void> {
  const raw = await call('kvGet', { key: CUSTOM_KEY }).catch(() => null);
  try {
    customThemes.value = raw ? (JSON.parse(raw) as Theme[]).map(sanitizeTheme) : [];
  } catch {
    customThemes.value = [];
  }
  applyTheme(allThemes().find((t) => t.id === themeId) ?? graphite);
}

export async function saveCustomTheme(theme: Theme): Promise<void> {
  const list = customThemes.value.filter((t) => t.id !== theme.id);
  customThemes.value = [...list, sanitizeTheme(theme)];
  await call('kvSet', { key: CUSTOM_KEY, value: JSON.stringify(customThemes.value) });
}

export async function deleteCustomTheme(id: string): Promise<void> {
  customThemes.value = customThemes.value.filter((t) => t.id !== id);
  await call('kvSet', { key: CUSTOM_KEY, value: JSON.stringify(customThemes.value) });
}

/** Partial theme as it may come from a file: every group optional, every field optional. */
export type ThemeInput = { [K in keyof Theme]?: Theme[K] extends object ? Partial<Theme[K]> : Theme[K] };

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v: unknown, min: number, max: number, def: number) =>
  typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : def;

/** Accepts partial or foreign JSON and fills everything missing from Graphite, clamping values to sane ranges. */
export function sanitizeTheme(input: ThemeInput): Theme {
  const g = graphite;
  const colors = { ...g.colors };
  for (const token of COLOR_TOKENS) {
    const v = (input.colors as Record<string, unknown> | undefined)?.[token];
    if (typeof v === 'string' && HEX.test(v)) colors[token] = v;
  }
  return {
    id: typeof input.id === 'string' && input.id ? input.id.slice(0, 64) : `custom-${Date.now()}`,
    name: typeof input.name === 'string' && input.name ? input.name.slice(0, 40) : 'Моя тема',
    version: 1,
    dark: typeof input.dark === 'boolean' ? input.dark : luminance(colors.bg) < 0.4,
    colors,
    radius: {
      cover: clamp(input.radius?.cover, 0, 32, g.radius.cover),
      card: clamp(input.radius?.card, 0, 32, g.radius.card),
      mini: clamp(input.radius?.mini, 0, 32, g.radius.mini),
    },
    font: {
      family: typeof input.font?.family === 'string' && !/[;{}]/.test(input.font.family) ? input.font.family : g.font.family,
      titleSize: clamp(input.font?.titleSize, 20, 40, g.font.titleSize),
    },
    spacing: { unit: clamp(input.spacing?.unit, 6, 12, g.spacing.unit) },
    motion: {
      press: clamp(input.motion?.press, 0, 600, g.motion.press),
      base: clamp(input.motion?.base, 0, 1000, g.motion.base),
      open: clamp(input.motion?.open, 0, 1200, g.motion.open),
      easing: typeof input.motion?.easing === 'string' && /^cubic-bezier\([\d.,\s-]+\)$|^ease/.test(input.motion.easing) ? input.motion.easing : g.motion.easing,
    },
    icons: {
      set: typeof input.icons?.set === 'string' ? input.icons.set : g.icons.set,
      stroke: clamp(input.icons?.stroke, 1, 2.5, g.icons.stroke),
    },
    dynamic: {
      intensity: clamp(input.dynamic?.intensity, 0, 1, g.dynamic.intensity),
      dim: clamp(input.dynamic?.dim, 0.3, 0.95, g.dynamic.dim),
    },
    grain: clamp(input.grain, 0, 0.08, g.grain),
    glass: input.glass === true,
  };
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Glow colour from a cover tone, with saturation capped so nothing shouts. */
export function mutedGlow(hex: string | null | undefined, maxSat = 0.35): string | null {
  if (!hex || !HEX.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  h = Math.round(h * 60 + 360) % 360;
  s = Math.min(s, maxSat);
  return `hsl(${h} ${Math.round(s * 100)}% ${Math.round(Math.min(Math.max(l, 0.3), 0.5) * 100)}%)`;
}
