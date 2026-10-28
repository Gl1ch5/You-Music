import { describe, expect, it } from 'vitest';
import type { Track } from '../bridge/contract';
import { artistKey, cleanTitle, normalizeTrack, songKey, splitArtists, versionTags } from './normalize';

const yt = (title: string, artist: string, extra: Partial<Track> = {}): Track => ({
  id: `yt:${title}`,
  source: 'yt',
  title,
  artist,
  durationMs: 200_000,
  ...extra,
});

describe('cleanTitle', () => {
  it.each([
    ['Rasputin (Official Video)', 'Rasputin'],
    ['Rasputin [Official Music Video]', 'Rasputin'],
    ['Rasputin (Lyrics)', 'Rasputin'],
    ['Rasputin (HD)', 'Rasputin'],
    ['Rasputin (Official Audio) [4K Remaster]', 'Rasputin'],
    ['Rasputin | Official Video', 'Rasputin'],
    ['Кадиллак (Премьера клипа, 2021)', 'Кадиллак'],
    ['«Вальс цветов»', 'Вальс цветов'],
  ])('%s → %s', (raw, clean) => expect(cleanTitle(raw)).toBe(clean));

  it('keeps version markers', () => {
    expect(cleanTitle('Raya (Slowed) (Official Audio)')).toBe('Raya (Slowed)');
    expect(cleanTitle('Song (feat. Someone)')).toBe('Song (feat. Someone)');
  });
});

describe('normalizeTrack', () => {
  it('splits "Artist - Title" uploads', () => {
    const t = normalizeTrack(yt('Boney M. - Rasputin (Official Video)', 'Renee Kelly'));
    expect(t.artist).toBe('Boney M.');
    expect(t.title).toBe('Rasputin');
  });

  it('uses the channel for Topic uploads', () => {
    const t = normalizeTrack(yt('Rasputin', 'Boney M. - Topic', { official: true }));
    expect(t).toMatchObject({ artist: 'Boney M.', title: 'Rasputin' });
  });

  it('strips VEVO suffixes', () => {
    expect(normalizeTrack(yt('Hello', 'AdeleVEVO')).artist).toBe('Adele');
  });

  it('leaves local files untouched', () => {
    const local: Track = { id: 'local:1', source: 'local', title: 'a - b (Lyrics)', artist: 'x', durationMs: 1 };
    expect(normalizeTrack(local)).toBe(local);
  });
});

describe('versions', () => {
  it('detects versions', () => {
    expect(versionTags('Raya (Slowed + Reverb)')).toEqual(['slowed']);
    expect(versionTags('Song (Sped Up)')).toEqual(['sped up']);
    expect(versionTags('Song - Extended Club Mix')).toEqual(['extended']);
    expect(versionTags('Song')).toEqual([]);
  });

  it('gives all versions of a song one key', () => {
    const a = songKey({ title: 'Raya', artist: 'Zericxxn' });
    expect(songKey({ title: 'Raya (Slowed)', artist: 'Zericxxn' })).toBe(a);
    expect(songKey({ title: 'Raya - Sped Up', artist: 'Zericxxn, Someone' })).toBe(a);
    expect(songKey({ title: 'Raya Remix', artist: 'zericxxn' })).toBe(a);
    expect(songKey({ title: 'Toscana', artist: 'Zericxxn' })).not.toBe(a);
  });

  it('keys artists by the first credit', () => {
    expect(artistKey('MORGENSHTERN, Элджей')).toBe('morgenshtern');
    expect(artistKey('Jiandro & Wbenix')).toBe('jiandro');
  });
});

describe('splitArtists', () => {
  it('splits credits', () => {
    expect(splitArtists('Elgy, MORGENSHTERN & Xcho feat. Kai')).toEqual(['Elgy', 'MORGENSHTERN', 'Xcho', 'Kai']);
    expect(splitArtists('Macan x Jah Khalib')).toEqual(['Macan', 'Jah Khalib']);
    expect(splitArtists('IOWA - Topic')).toEqual(['IOWA']);
  });
});
