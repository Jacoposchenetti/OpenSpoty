/* "Recenti" under the search bar, like Spotify: searches and what was opened from them */

export interface Recent {
  kind: 'query' | 'artist' | 'album' | 'playlist' | 'song' | 'podcast'
  id: string // the query, a Spotify uri or a song id
  title: string
  sub?: string
  image?: string
}

const KEY = 'stemkit:recents'

export function loadRecents(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Recent[]
  } catch {
    return []
  }
}

function save(list: Recent[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 20)))
  } catch {
    /* private mode */
  }
}

export function addRecent(r: Recent) {
  save([r, ...loadRecents().filter((x) => !(x.kind === r.kind && x.id === r.id))])
}

export function removeRecent(r: Recent) {
  save(loadRecents().filter((x) => !(x.kind === r.kind && x.id === r.id)))
}

export const clearRecents = () => save([])
