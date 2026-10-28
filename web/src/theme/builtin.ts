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

export const builtinThemes: Theme[] = [graphite, paper, amoled];
