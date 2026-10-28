import { call } from '../bridge/bridge';
import type { Track, TrackInfo } from '../bridge/contract';
import { formatBytes, h, replaceChildren } from '../core/dom';
import { emptyState, listItem, skeletonRows } from './components';
import { openSheet } from './sheet';
import { trackHeader } from './trackMenu';

const SOURCE: Record<TrackInfo['source'], string> = {
  download: 'Скачан на устройство',
  cache: 'Из кэша',
  stream: 'Поток из сети',
  local: 'Ваш файл',
};

/** "О треке": where the sound comes from and its format — codec, bitrate, size. */
export function openTrackInfo(track: Track): void {
  const body = h('div', null, skeletonRows(4));
  openSheet({ header: trackHeader(track), content: body });
  call('trackInfo', { track })
    .then((info) => {
      const rows: [string, string][] = [['Источник', SOURCE[info.source]]];
      if (info.codec || info.container) rows.push(['Формат', [info.codec, info.container].filter(Boolean).join(' · ')]);
      if (info.bitrateKbps) rows.push(['Битрейт', `${Math.round(info.bitrateKbps)} кбит/с`]);
      if (info.sampleRateHz) rows.push(['Частота', `${(info.sampleRateHz / 1000).toFixed(1).replace('.0', '')} кГц${info.channels ? ` · ${info.channels === 1 ? 'моно' : info.channels === 2 ? 'стерео' : `${info.channels} канала`}` : ''}`]);
      if (info.sizeBytes) rows.push(['Размер', formatBytes(info.sizeBytes)]);
      if (info.cachedBytes && info.source !== 'download' && info.source !== 'local') rows.push(['В кэше', formatBytes(info.cachedBytes)]);
      replaceChildren(
        body,
        rows.map(([title, sub]) => listItem({ title, sub })),
        info.source === 'stream' || info.source === 'cache' ? h('div.pad.small.faint', null, 'YouTube отдаёт звук в Opus или AAC до ~160 кбит/с — это максимум, который есть у источника.') : null,
      );
    })
    .catch(() => replaceChildren(body, emptyState('info', 'Нет данных', 'Сведения появятся, когда трек начнёт загружаться.')));
}
