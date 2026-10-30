import { describe, expect, it } from 'vitest';
import type { Track } from '../bridge/contract';
import { artistKey, cleanTitle, normalizeTrack, songKey, songKeys, splitArtists, versionTags } from './normalize';

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

  it('keys uploads titled only by their version by the artist field', () => {
    const a = songKey({ title: 'Sped Up', artist: 'LO0K' });
    expect(songKey({ title: 'Ultra Slowed', artist: 'LO0K' })).toBe(a);
    expect(songKey({ title: 'slowed + reverb', artist: 'LO0K' })).toBe(a);
    expect(songKey({ title: 'Super Bass', artist: 'Nicki Minaj' })).toContain('super bass');
  });

  it('keys re-uploads of one song the same', () => {
    const a = songKey({ title: 'Белые ночи', artist: 'Сплин' });
    expect(songKey({ title: 'Сплин - Белые ночи (Official Video)', artist: 'Russian Rock Channel' })).toBe(a);
    expect(songKey({ title: 'Белые ночи | текст песни', artist: 'Сплин' })).toBe(a);
    expect(songKey({ title: 'Belye nochi', artist: 'Splin' })).toBe(a);
    expect(songKey({ title: 'Белые ночи', artist: 'Splin' })).toBe(a);
    expect(songKey({ title: 'Beyoncé - Halo (Lyrics)', artist: 'Lyrics Hub' })).toBe(songKey({ title: 'Halo', artist: 'Beyonce' }));
  });

  it('shares a title key for distinctive titles only', () => {
    const a = songKeys({ title: 'Fall From The Sky', artist: 'RomancePlanet' });
    const b = songKeys({ title: 'Fall From The Sky (slowed)', artist: 'Some Edits' });
    expect(a.some((k) => b.includes(k))).toBe(true);
    expect(songKeys({ title: 'Halo', artist: 'Beyonce' })).toHaveLength(1);
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

describe('normalizeTrack official', () => {
  it('drops the artist repeated in an official title', () => {
    const t = normalizeTrack({ id: 'yt:x', source: 'yt', title: 'Sia - Snowman [Official Video]', artist: 'Sia', durationMs: 1, official: true });
    expect(t.title).toBe('Snowman');
  });
});
