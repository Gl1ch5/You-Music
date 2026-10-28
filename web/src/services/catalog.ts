import { call } from '../bridge/bridge';
import type { ArtistPage, CollectionPage, SearchFilter, SearchItem, Track } from '../bridge/contract';
import { app } from '../core/store';
import { normalizeTrack, versionTags } from '../logic/normalize';
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

/** Related tracks of a YouTube track (used by recommendations and the "Похожие" tab). Cached for the session. */
export function related(track: Track): Promise<Track[]> {
  if (track.source !== 'yt') return Promise.resolve([]);
  let p = relatedCache.get(track.id);
  if (!p) {
    p = call('trackDetails', { id: track.id })
      .then((d) => d.related.map(normalizeTrack))
      .catch((e) => {
        relatedCache.delete(track.id);
        throw e;
      });
    relatedCache.set(track.id, p);
  }
  return p;
}
