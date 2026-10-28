export const COLOR_TOKENS = ['bg', 'surface', 'surface-2', 'line', 'text', 'text-2', 'text-3', 'accent', 'on-accent', 'like', 'danger'] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];

/** A theme is plain JSON: import/export it as a file, edit it in Settings → Theme editor. */
export interface Theme {
  id: string;
  name: string;
  version: 1;
  dark: boolean;
  colors: Record<ColorToken, string>;
  radius: { cover: number; card: number; mini: number };
  font: { family: string; titleSize: number };
  spacing: { unit: number };
  motion: { press: number; base: number; open: number; easing: string };
  icons: { set: string; stroke: number };
  /** intensity: opacity of the blurred cover layer; dim: opacity of the graphite layer over it. */
  dynamic: { intensity: number; dim: number };
  grain: number;
  /** Liquid glass: translucent, blurred mini player, tab bar and sheets over a colourful backdrop. */
  glass?: boolean;
}

export const COLOR_LABELS: Record<ColorToken, string> = {
  bg: 'Фон',
  surface: 'Поверхность',
  'surface-2': 'Поднятые элементы',
  line: 'Линии',
  text: 'Текст',
  'text-2': 'Вторичный текст',
  'text-3': 'Подписи',
  accent: 'Акцент',
  'on-accent': 'На акценте',
  like: 'Лайк',
  danger: 'Удаление и ошибки',
};
