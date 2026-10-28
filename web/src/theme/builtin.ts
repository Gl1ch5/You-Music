import type { Theme } from './types';

const graphiteColors = {
  bg: '#161719',
  surface: '#1E1F22',
  'surface-2': '#26282B',
  line: '#2F3135',
  text: '#ECEAE6',
  'text-2': '#9B9CA0',
  'text-3': '#64666B',
  accent: '#E6E2DA',
  'on-accent': '#161719',
  like: '#E6E2DA',
  danger: '#D9726A',
};

const base: Omit<Theme, 'id' | 'name' | 'colors' | 'dark'> = {
  version: 1,
  radius: { cover: 12, card: 16, mini: 14 },
  font: { family: "'Inter Variable', 'Inter', system-ui, sans-serif", titleSize: 28 },
  spacing: { unit: 8 },
  motion: { press: 90, base: 160, open: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  icons: { set: 'graphite', stroke: 1.5 },
  dynamic: { intensity: 0.5, dim: 0.72 },
  grain: 0.025,
};

export const graphite: Theme = { ...base, id: 'graphite', name: 'Graphite', dark: true, colors: graphiteColors };

export const paper: Theme = {
  ...base,
  id: 'paper',
  name: 'Paper',
  dark: false,
  colors: {
    bg: '#F2F1EE',
    surface: '#FAF9F7',
    'surface-2': '#E9E7E3',
    line: '#DDDAD5',
    text: '#1C1D1F',
    'text-2': '#5E6064',
    'text-3': '#8E9094',
    accent: '#1C1D1F',
    'on-accent': '#F2F1EE',
    like: '#1C1D1F',
    danger: '#B4544C',
  },
  dynamic: { intensity: 0.45, dim: 0.78 },
  grain: 0.03,
};

export const amoled: Theme = {
  ...base,
  id: 'amoled',
  name: 'AMOLED',
  dark: true,
  colors: { ...graphiteColors, bg: '#000000', surface: '#0E0F10' },
  grain: 0.02,
};

/** Real liquid glass: translucent blurred panels (see `.glass` in components.css) over a deep gradient. */
export const liquidGlass: Theme = {
  ...base,
  id: 'liquid-glass',
  name: 'Liquid Glass',
  dark: true,
  colors: {
    bg: '#0B1020',
    surface: '#1A2238',
    'surface-2': '#273150',
    line: '#3A4566',
    text: '#F4F6FF',
    'text-2': '#AEB6D0',
    'text-3': '#717A98',
    accent: '#9CC8FF',
    'on-accent': '#0B1020',
    like: '#FF8FB1',
    danger: '#FF7A7A',
  },
  radius: { cover: 16, card: 24, mini: 22 },
  motion: { press: 110, base: 200, open: 300, easing: 'cubic-bezier(0.25, 1.1, 0.35, 1)' },
  dynamic: { intensity: 0.75, dim: 0.55 },
  grain: 0,
  glass: true,
};

export const catppuccin: Theme = {
  ...base,
  id: 'catppuccin',
  name: 'Catppuccin Mocha',
  dark: true,
  colors: {
    bg: '#1E1E2E',
    surface: '#24273A',
    'surface-2': '#313244',
    line: '#45475A',
    text: '#CDD6F4',
    'text-2': '#A6ADC8',
    'text-3': '#7F849C',
    accent: '#CBA6F7',
    'on-accent': '#1E1E2E',
    like: '#F38BA8',
    danger: '#F38BA8',
  },
  radius: { cover: 14, card: 18, mini: 16 },
  grain: 0.015,
};

export const nord: Theme = {
  ...base,
  id: 'nord',
  name: 'Nord',
  dark: true,
  colors: {
    bg: '#2E3440',
    surface: '#353C4A',
    'surface-2': '#3B4252',
    line: '#4C566A',
    text: '#ECEFF4',
    'text-2': '#C0C8D6',
    'text-3': '#8691A6',
    accent: '#88C0D0',
    'on-accent': '#2E3440',
    like: '#BF616A',
    danger: '#BF616A',
  },
  grain: 0.015,
};

export const synthwave: Theme = {
  ...base,
  id: 'synthwave',
  name: 'Synthwave',
  dark: true,
  colors: {
    bg: '#140B26',
    surface: '#1F1238',
    'surface-2': '#2C1A4D',
    line: '#3D2766',
    text: '#FBEFFF',
    'text-2': '#C9A8E8',
    'text-3': '#8A6BB0',
    accent: '#FF5FD2',
    'on-accent': '#140B26',
    like: '#36F9F6',
    danger: '#FE4450',
  },
  radius: { cover: 8, card: 12, mini: 10 },
  dynamic: { intensity: 0.7, dim: 0.6 },
  grain: 0.03,
};

export const builtinThemes: Theme[] = [graphite, paper, amoled, liquidGlass, catppuccin, nord, synthwave];
