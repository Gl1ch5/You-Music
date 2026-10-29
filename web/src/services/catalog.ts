import { call } from '../bridge/bridge';
import type { BridgeError } from '../bridge/bridge';
import type { ArtistPage, CollectionPage, ImportedTrack, SearchFilter, SearchItem, Track } from '../bridge/contract';
import { app } from '../core/store';
import { normalizeTrack, versionTags } from '../logic/normalize';
import { bestMatch } from '../logic/match';
import { rankTracks } from '../logic/rank';
import { hooks, runHooks } from '../mods/registry';

/** Catalogue access for screens: every track coming from YouTube is normalized here, search results are ranked. */

export interface SearchResult {
  items: SearchItem[];
  nextPage: string | null;
}

export async function search(query: string, filter: SearchFilter, page: string | null = null): Promise<SearchResult> {
  const res = await call('search', { query, filter, page });
  const rawTitles = new Map<string, string>();
  const tracks: Track[] = [];
  const others: SearchItem[] = [];
  for (const item of res.items) {
    if (item.kind === 'track' && item.track) {
      rawTitles.set(item.track.id, item.track.title);
      tracks.push(normalizeTrack(item.track));
    } else {
      others.push(item);
    }
  }
  let ranked = filter === 'videos' ? tracks : rankTracks(tracks, query, rawTitles);
  if (app.settings.peek().hideVersionsInSearch) {
    const wanted = new Set(versionTags(query));
    ranked = ranked.filter((t) => versionTags(t.title).every((v) => wanted.has(v)));
  }
  ranked = await runHooks(hooks.search, ranked, { query });
  return { items: [...others, ...ranked.map((track) => ({ kind: 'track' as const, track }))], nextPage: res.nextPage ?? null };
}

export const suggestions = (query: string) => call('searchSuggestions', { query });

export async function collection(url: string): Promise<CollectionPage> {
  const page = await call('getCollection', { url });
  const albumArt = page.collection.kind === 'album' ? page.collection.artwork : null;
  return {
    ...page,
    tracks: page.tracks.map((t) => {
      const n = normalizeTrack(t);
      return albumArt ? { ...n, artwork: albumArt, album: page.collection.title } : n;
    }),
  };
}

export async function artist(url: string): Promise<ArtistPage> {
  const page = await call('getArtist', { url });
  return { ...page, tracks: page.tracks.map(normalizeTrack) };
}

const relatedCache = new Map<string, Promise<Track[]>>();

/**
 * Related songs of a YouTube track (used by recommendations and the "Похожие" tab): YouTube Music's own radio
 * for it first — songs only, what YouTube itself would play next — then the video's "related" list, which
 * mixes in non-music videos (the wave drops those). Cached for the session.
 */
export function related(track: Track): Promise<Track[]> {
  if (track.source !== 'yt') return Promise.resolve([]);
  let p = relatedCache.get(track.id);
  if (!p) {
    const radio = call('trackRadio', { id: track.id }).catch(() => [] as Track[]);
    const videos = call('trackDetails', { id: track.id }).then((d) => d.related);
    p = Promise.allSettled([radio, videos])
      .then(([r, v]) => {
        const list = [...(r.status === 'fulfilled' ? r.value : []), ...(v.status === 'fulfilled' ? v.value : [])];
        if (!list.length && v.status === 'rejected') throw v.reason;
        const ids = new Set<string>();
        return list.filter((t) => t.id !== track.id && !ids.has(t.id) && !!ids.add(t.id)).map(normalizeTrack);
      })
      .catch((e) => {
        relatedCache.delete(track.id);
        throw e;
      });
    relatedCache.set(track.id, p);
  }
  return p;
}

/** Finds the YouTube upload that best matches a track known by artist and title (imports, AI suggestions). */
export async function findTrack(src: ImportedTrack): Promise<Track | null> {
  const query = `${src.artist} ${src.title}`.trim();
  for (const filter of ['songs', 'all'] as const) {
    try {
      const res = await search(query, filter);
      const match = bestMatch(src, res.items.flatMap((i) => (i.track ? [i.track] : [])));
      if (match) return match;
    } catch (e) {
      if ((e as BridgeError).code === 'offline') throw e;
    }
  }
  return null;
}

/**
 * A track found for an imported one keeps the source's clean metadata and its square, high-resolution cover:
 * lyrics are looked up by exact artist/title and the cover is the release art, not a video frame.
 */
export function adoptSourceMeta(match: Track, src: ImportedTrack): Track {
  return {
    ...match,
    title: src.title || match.title,
    artist: src.artist || match.artist,
    artwork: src.artwork || match.artwork,
    album: src.album || match.album,
  };
}
