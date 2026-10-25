import { ArrowRightLeft, AudioLines, Check, ChevronLeft, CircleArrowDown, Download, EllipsisVertical, Heart, MicVocal, ListEnd, ListMusic, ListPlus, Music, NotebookPen, Pause, Pencil, Play, Plus, Shuffle, SlidersVertical, Trash2, X, Share2, Disc3 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { PromptSheet, Sheet, SongThumb, SortableList, Spinner, StemDots, useBackHandler } from '../components/ui'
import { engine } from '../lib/engine'
import { fmtTime } from '../lib/format'
import { sharePlaylist, shareSong } from '../lib/share'
import { artistOf, isDownloaded, nameParts, youtubeIdOf } from '../lib/media'
import { artistsOf, PlaylistSuggestions, useOpenAlbum, useOpenArtist } from './Catalog'
import { FastScroll } from '../components/FastScroll'
import type { Playlist, Song } from '../lib/types'
import { usePlayback } from '../playback'
import { useStore } from '../store'
import { t } from '../lib/i18n'

export { StemDots } from '../components/ui'

/** "Artista – Titolo" (YouTube / Spotify style titles): the artist part, or '' */
export { artistOf } from '../lib/media'

const fold = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

type SortKey = 'custom' | 'recent' | 'title' | 'artist'

const totalTime = (songs: Song[]) => {
  const s = songs.reduce((t, x) => t + (x.duration || 0), 0)
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}

export function Library() {
  const store = useStore()
  if (store.libView === null) return <Overview />
  return <ListView key={store.libView} viewId={store.libView} />
}

/* ------------------------------------------------------------- overview */

function Overview() {
  const store = useStore()
  const [creating, setCreating] = useState(false)
  const [menu, setMenu] = useState<Playlist | null>(null)
  const [renaming, setRenaming] = useState<Playlist | null>(null)
  const [deleting, setDeleting] = useState<Playlist | null>(null)
  const playback = usePlayback()
  const byId = new Map(store.songs.map((s) => [s.id, s]))
  const liked = store.songs.filter((s) => s.liked)
  const recent = store.songs
    .filter((s) => s.playedAt)
    .sort((a, b) => (b.playedAt ?? 0) - (a.playedAt ?? 0))
    .slice(0, 10)

  return (
    <div className="lib">
      {recent.length > 0 && (
        <>
          <div className="q-head">{t('Ascoltati di recente')}</div>
          <div className="recent">
            {recent.map((s) => (
              <button key={s.id} className="recent-item" onClick={() => playback.playSong(s.id)}>
                <SongThumb song={s} size={96} />
                <span className="recent-title">{nameParts(s.title).name}</span>
                <span className="recent-artist">{nameParts(s.title).artist}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <div className="lib-head">
        <h1>{t('La tua libreria')}</h1>
        <button className="small" onClick={() => setCreating(true)}>
          <Plus /> {t('Playlist')}
        </button>
      </div>

      <button className="lib-row" onClick={() => store.setLibView('all')}>
        <span className="thumb ph all" style={{ width: 56, height: 56 }}>
          <Music />
        </span>
        <span className="lib-text">
          <span className="row-title">{t('Tutti i brani')}</span>
          <span className="row-sub">{store.songs.length} {t(store.songs.length === 1 ? 'brano' : 'brani')}</span>
        </span>
      </button>

      {liked.length > 0 && (
        <button className="lib-row" onClick={() => store.setLibView('liked')}>
          <span className="thumb ph liked" style={{ width: 56, height: 56 }}>
            <Heart fill="currentColor" />
          </span>
          <span className="lib-text">
            <span className="row-title">{t('Brani che ti piacciono')}</span>
            <span className="row-sub">{liked.length} {t(liked.length === 1 ? 'brano' : 'brani')}</span>
          </span>
        </button>
      )}

      <SortableList
        items={store.playlists}
        keyOf={(p) => p.id}
        onMove={store.reorderPlaylists}
        render={(p, _i, handle) => {
        const first = p.songIds.map((id) => byId.get(id)).find(Boolean)
        return (
          <div className="lib-row-wrap">
            <button className="lib-row" onClick={() => store.setLibView(p.id)}>
              {first ? <SongThumb song={first} size={56} /> : <span className="thumb ph" style={{ width: 56, height: 56 }}><ListMusic /></span>}
              <span className="lib-text">
                <span className="row-title">{p.name}</span>
                <span className="row-sub">{t('Playlist')} · {p.songIds.filter((id) => byId.has(id)).length} {t(p.songIds.filter((id) => byId.has(id)).length === 1 ? 'brano' : 'brani')}</span>
              </span>
            </button>
            <button className="icon-btn" onClick={() => setMenu(p)} aria-label={`${t('Opzioni')} ${p.name}`}>
              <EllipsisVertical />
            </button>
            {store.playlists.length > 1 && handle}
          </div>
        )
        }}
      />

      {store.artists.length > 0 && (
        <>
          <div className="q-head">{t('Artisti che segui')}</div>
          {store.artists.map((a) => (
            <button key={a.id} className="lib-row" onClick={() => store.openPage({ kind: 'artist', uri: a.id, name: a.name })}>
              {a.image ? (
                <img className="thumb round" src={a.image} alt="" loading="lazy" style={{ width: 56, height: 56 }} />
              ) : (
                <span className="thumb ph round" style={{ width: 56, height: 56 }} />
              )}
              <span className="lib-text">
                <span className="row-title">{a.name}</span>
                <span className="row-sub">{t('Artista')}</span>
              </span>
            </button>
          ))}
        </>
      )}

      {store.podcasts.length > 0 && (
        <>
          <div className="q-head">{t('Podcast che segui')}</div>
          {store.podcasts.map((p) => (
            <button key={p.feed} className="lib-row" onClick={() => store.openPage({ kind: 'podcast', uri: p.feed, name: p.name })}>
              {p.image ? (
                <img className="thumb" src={p.image} alt="" loading="lazy" style={{ width: 56, height: 56 }} />
              ) : (
                <span className="thumb ph" style={{ width: 56, height: 56 }} />
              )}
              <span className="lib-text">
                <span className="row-title">{p.name}</span>
                <span className="row-sub">{t('Podcast')}</span>
              </span>
            </button>
          ))}
        </>
      )}

      {!store.songs.length && (
        <div className="empty">
          <p className="big">{t('Ancora nessuna canzone')}</p>
          <p>{t('Cercale e separale dalla scheda Cerca.')}</p>
          <button className="primary" onClick={() => store.setTab('add')}>
            {t('Cerca una canzone')}
          </button>
        </div>
      )}
      {store.songs.length > 0 && !store.playlists.length && (
        <p className="muted hint">{t('Crea una playlist per la serata con “Playlist”: poi puoi riordinarla trascinando i brani.')}</p>
      )}

      {creating && (
        <PromptSheet
          title={t('Nuova playlist')}
          placeholder={t('Es. Serata sabato')}
          confirm={t('Crea')}
          onDone={(name) => store.setLibView(store.createPlaylist(name))}
          onClose={() => setCreating(false)}
        />
      )}
      {menu && <PlaylistMenu playlist={menu} onClose={() => setMenu(null)} onRename={() => setRenaming(menu)} onDelete={() => setDeleting(menu)} />}
      {renaming && (
        <PromptSheet
          title={t('Rinomina playlist')}
          initial={renaming.name}
          confirm={t('Salva')}
          onDone={(name) => store.renamePlaylist(renaming.id, name)}
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting && <DeletePlaylist playlist={deleting} onClose={() => setDeleting(null)} />}
    </div>
  )
}

function PlaylistMenu({ playlist, onClose, onRename, onDelete }: { playlist: Playlist; onClose: () => void; onRename: () => void; onDelete: () => void }) {
  const store = useStore()
  const songs = playlist.songIds.map((id) => store.getSong(id)).filter((s): s is Song => !!s)
  return (
    <Sheet title={playlist.name} onClose={onClose}>
      <button onClick={() => (onClose(), void sharePlaylist(playlist.name, songs).then((r) => r === 'copied' && store.showToast('Copiata negli appunti')))}>
        <Share2 /> {t('Condividi')}
      </button>
      <button onClick={() => (onClose(), onRename())}><Pencil /> {t('Rinomina')}</button>
      <button className="danger" onClick={() => (onClose(), onDelete())}>
        <Trash2 /> {t('Elimina playlist')}
      </button>
    </Sheet>
  )
}

function DeletePlaylist({ playlist, onClose }: { playlist: Playlist; onClose: () => void }) {
  const store = useStore()
  return (
    <Sheet title={`Eliminare “${playlist.name}”?`} onClose={onClose}>
      <p className="muted">{t('Le canzoni restano nella libreria: sparisce solo la playlist.')}</p>
      <button
        className="danger solid"
        onClick={() => {
          if (store.libView === playlist.id) store.setLibView(null)
          store.deletePlaylist(playlist.id)
          onClose()
        }}
      >
        {t('Elimina playlist')}
      </button>
      <button onClick={onClose}>{t('Annulla')}</button>
    </Sheet>
  )
}

/* ------------------------------------------------------------- one list */

function ListView({ viewId }: { viewId: string }) {
  const store = useStore()
  const playback = usePlayback()
  const isLiked = viewId === 'liked'
  const playlist = viewId === 'all' || isLiked ? null : store.playlists.find((p) => p.id === viewId) ?? null
  const byId = new Map(store.songs.map((s) => [s.id, s]))
  const ids = playlist
    ? playlist.songIds.filter((id) => byId.has(id))
    : isLiked
      ? store.songs.filter((s) => s.liked).sort((a, b) => (b.likedAt ?? 0) - (a.likedAt ?? 0)).map((s) => s.id)
      : store.songs.map((s) => s.id)
  const items = ids.map((id) => byId.get(id)!)
  // a playlist can name songs still on their way from the other device:
  // what is shown maps back to the playlist's own positions
  const slots = playlist ? playlist.songIds.flatMap((id, i) => (byId.has(id) ? [i] : [])) : []
  const raw = (i: number) => (playlist ? slots[i] : i)
  const name = playlist ? playlist.name : isLiked ? 'Brani che ti piacciono' : 'Tutti i brani'
  const [songMenu, setSongMenu] = useState<{ song: Song; index: number } | null>(null)
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortKey>(playlist || isLiked ? 'custom' : 'recent')

  useBackHandler(() => store.setLibView(null))

  // the songs at the top of the list are the likeliest to be played: prepare their streams
  useEffect(() => {
    const ids = items.filter((s) => !isDownloaded(s)).flatMap((s) => youtubeIdOf(s.id) ?? [])
    engine.warm(ids.slice(0, 5), 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId])

  if (viewId !== 'all' && !isLiked && !playlist) return null

  // what is shown (and played, in this order): filtered by the search, sorted
  const q = fold(query.trim())
  let visible = items.map((song, index) => ({ song, index: raw(index) }))
  if (q) visible = visible.filter(({ song }) => fold(song.title).includes(q))
  if (sort === 'recent') visible.sort((a, b) => (b.song.addedAt || 0) - (a.song.addedAt || 0))
  if (sort === 'title') visible.sort((a, b) => fold(a.song.title).localeCompare(fold(b.song.title)))
  if (sort === 'artist')
    visible.sort((a, b) => {
      const x = fold(artistOf(a.song.title)), y = fold(artistOf(b.song.title))
      if (!x !== !y) return x ? -1 : 1 // songs without an artist go last
      return x.localeCompare(y) || fold(a.song.title).localeCompare(fold(b.song.title))
    })
  const visibleIds = visible.map((v) => v.song.id)
  const draggable = !!playlist && sort === 'custom' && !q

  const play = (index: number) => playback.playList(visibleIds, index, name)
  const shuffle = () => {
    const order = [...visibleIds].sort(() => Math.random() - 0.5)
    playback.playList(order, 0, name)
  }

  /** @param pos position in the shown list (what plays) @param index position in the playlist */
  const row = (song: Song, pos: number, index: number, handle?: ReactNode) => {
    const current = playback.now?.songId === song.id
    const { name, artist } = nameParts(song.title)
    return (
      <div className={`song-row ${current ? 'current' : ''}`}>
        <button className="song-main" onClick={() => play(pos)}>
          <SongThumb song={song} />
          <span className="lib-text">
            <span className="row-title">
              {current && (
                <span className="eq">{playback.loading ? <Spinner size={14} /> : playback.playing ? <AudioLines /> : <Pause fill="currentColor" />}</span>
              )}
              {name}
            </span>
            <span className="row-sub">
              {artist && <span className="row-artist">{artist}</span>}
              {song.liked && <Heart className="heart-mini" fill="currentColor" />}
              {song.stems.length ? (
                <StemDots stems={song.stems} />
              ) : store.downloading.includes(song.id) ? (
                <Spinner size={13} />
              ) : isDownloaded(song) ? (
                <CircleArrowDown className="dl-mark" aria-label={t('Scaricata')} />
              ) : null}
              {store.deviceJob?.state === 'running' && store.deviceJob.songId === song.id ? (
        <span className="tag busy">{t('separazione')} {Math.round(store.deviceJob.pct)}%</span>
              ) : (
                fmtTime(song.duration)
              )}
            </span>
          </span>
        </button>
        {song.notes && playlist && <NotebookPen className="row-note" />}
        <button className="icon-btn" onClick={() => setSongMenu({ song, index })} aria-label={`${t('Opzioni')} ${song.title}`}>
          <EllipsisVertical />
        </button>
        {handle}
      </div>
    )
  }

  return (
    <div className="lib">
      <div className="list-top">
        <button className="icon-btn back" onClick={() => store.setLibView(null)} aria-label={t('Indietro')}>
          <ChevronLeft />
        </button>
        <div className="list-title">
          <h1>{name}</h1>
          <span className="row-sub">
            {items.length} {t(items.length === 1 ? 'brano' : 'brani')} · {totalTime(items)}
          </span>
        </div>
        {playlist && (
          <button className="icon-btn" onClick={() => setMenu(true)} aria-label={t('Opzioni playlist')}>
            <EllipsisVertical />
          </button>
        )}
      </div>

      {items.length > 3 && (
        <div className="lib-tools">
          <input placeholder={t('Cerca in questa lista')} value={query} onChange={(e) => setQuery(e.target.value)} enterKeyHint="search" />
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label={t('Ordina')}>
            {(playlist || isLiked) && <option value="custom">{isLiked ? t('Aggiunti di recente') : t('Ordine playlist')}</option>}
            <option value="recent">{t('Aggiunte di recente')}</option>
            <option value="title">{t('Titolo A–Z')}</option>
            <option value="artist">{t('Artista')}</option>
          </select>
        </div>
      )}

      <div className="list-actions">
        <button className="primary" disabled={!items.length} onClick={() => play(0)}>
          <Play fill="currentColor" /> {t('Riproduci')}
        </button>
        <button disabled={items.length < 2} onClick={shuffle}>
          <Shuffle /> {t('Casuale')}
        </button>
        {playlist && <button className="icon-only" onClick={() => setAdding(true)} aria-label={t('Aggiungi brani')}><Plus /></button>}
        <DownloadToggle songs={items} />
      </div>

      {draggable ? (
        <SortableList items={items} keyOf={(s, i) => `${s.id}:${i}`} onMove={(from, to) => store.reorderPlaylist(playlist!.id, raw(from), raw(to))} render={(s, i, handle) => row(s, i, raw(i), handle)} />
      ) : (
        visible.map((v, i) => <div key={`${v.song.id}:${v.index}`}>{row(v.song, i, v.index)}</div>)
      )}
        {q && !visible.length && <p className="muted hint">{t('Nessun brano con “{query}”.', { query: query.trim() })}</p>}

      {!items.length && (
        <div className="empty">
          <p className="big">{playlist ? t('Playlist vuota') : t('Nessuna canzone')}</p>
          {playlist ? (
            <button className="primary" onClick={() => setAdding(true)}>
              <Plus /> {t('Aggiungi brani')}
            </button>
          ) : (
            <button className="primary" onClick={() => store.setTab('add')}>
              {t('Cerca una canzone')}
            </button>
          )}
        </div>
      )}
      {draggable && items.length > 1 && <p className="muted hint">{t('Tieni premuto e trascina per cambiare l’ordine.')}</p>}
      {playlist && !q && <PlaylistSuggestions playlist={playlist} />}
      <FastScroll />

      {songMenu && <SongMenu song={songMenu.song} index={songMenu.index} playlist={playlist} onClose={() => setSongMenu(null)} />}
      {adding && playlist && <AddSongs playlist={playlist} onClose={() => setAdding(false)} />}
      {menu && playlist && (
        <PlaylistMenu playlist={playlist} onClose={() => setMenu(false)} onRename={() => setRenaming(true)} onDelete={() => setDeleting(true)} />
      )}
      {renaming && playlist && (
        <PromptSheet
          title={t('Rinomina playlist')}
          initial={playlist.name}
          confirm={t('Salva')}
          onDone={(n) => store.renamePlaylist(playlist.id, n)}
          onClose={() => setRenaming(false)}
        />
      )}
      {deleting && playlist && <DeletePlaylist playlist={playlist} onClose={() => setDeleting(false)} />}
    </div>
  )
}

/* ------------------------------------------------------------- song menu */

export function SongMenu({ song, index, playlist, onClose }: { song: Song; index: number; playlist: Playlist | null; onClose: () => void }) {
  const store = useStore()
  const openArtist = useOpenArtist()
  const openAlbum = useOpenAlbum()
  const playback = usePlayback()
  const [mode, setMode] = useState<null | 'add' | 'move' | 'rename' | 'delete' | 'artists'>(null)
  const artists = artistsOf(song)
  // a song only heard (search, artist pages, autoplay): saved first when you keep it somewhere
  const inLib = store.songs.some((s) => s.id === song.id)
  const keep = () => {
    if (!inLib) store.addToLibrary(song, true)
  }

  if (mode === 'add' || mode === 'move') {
    return (
      <PlaylistPicker
        title={mode === 'add' ? t('Aggiungi a playlist') : t('Sposta in…')}
        exclude={mode === 'move' ? playlist?.id : undefined}
        onClose={onClose}
        onPick={(pid, pname) => {
          if (mode === 'move' && playlist) {
            store.moveToPlaylist(playlist.id, index, pid)
            store.showToast(t('Spostata in “{name}”', { name: pname }))
          } else {
            keep()
            const n = store.addToPlaylist(pid, [song.id])
            store.showToast(n ? t('Aggiunta a “{name}”', { name: pname }) : t('È già in “{name}”', { name: pname }))
          }
        }}
      />
    )
  }
  if (mode === 'artists') {
    return (
      <Sheet title={t('Vai agli artisti')} onClose={onClose}>
        {artists.map((a) => (
          <button key={a.name} onClick={() => (void openArtist(song, a), onClose())}>
            <MicVocal /> {a.name}
          </button>
        ))}
      </Sheet>
    )
  }
  if (mode === 'rename') {
    return <PromptSheet title={t('Rinomina brano')} initial={song.title} confirm={t('Salva')} onDone={(t) => void store.renameSong(song.id, t)} onClose={onClose} />
  }
  if (mode === 'delete') {
    return (
      <Sheet title={`Eliminare “${song.title}” dal telefono?`} onClose={onClose}>
        <p className="muted">{t('Sparisce dalla libreria e da tutte le playlist. Le tracce separate vengono cancellate.')}</p>
        <button className="danger solid" onClick={() => (void store.removeSong(song.id), onClose())}>
          {t('Elimina')}
        </button>
        <button onClick={onClose}>{t('Annulla')}</button>
      </Sheet>
    )
  }

  return (
    <Sheet
      title={
        <span className="sheet-song">
          <SongThumb song={song} size={44} />
          <span className="sheet-song-text">
            <span>{nameParts(song.title).name}</span>
            <span className="muted small">{nameParts(song.title).artist}</span>
          </span>
        </span>
      }
      onClose={onClose}
    >
      {!inLib && (
        <button onClick={() => (store.addToLibrary(song), onClose())}>
          <Plus /> {t('Aggiungi alla libreria')}
        </button>
      )}
      <button onClick={() => (playback.enqueue(song.id), store.showToast(t('Aggiunta alla coda')), onClose())}><ListEnd /> {t('Metti in coda')}</button>
      <button onClick={() => (onClose(), void shareSong(song).then((r) => r === 'copied' && store.showToast('Link copiato')))}>
        <Share2 /> {t('Condividi')}
      </button>
      <button
        onClick={() => {
          keep()
          store.updateSong(song.id, song.liked ? { liked: false } : { liked: true, likedAt: Date.now() })
          onClose()
        }}
      >
        <Heart fill={song.liked ? 'none' : 'currentColor'} />
        {song.liked ? t('Togli da “Brani che ti piacciono”') : t('Aggiungi a “Brani che ti piacciono”')}
      </button>
      <button onClick={() => setMode('add')}><ListPlus /> {t('Aggiungi a playlist…')}</button>
      {playlist && <button onClick={() => setMode('move')}><ArrowRightLeft /> {t('Sposta in un’altra playlist…')}</button>}
      {playlist && (
        <button onClick={() => (store.removeFromPlaylist(playlist.id, index), onClose())}><X /> {t('Rimuovi da “{name}”', { name: playlist.name })}</button>
      )}
      {artists.length > 1 ? (
        <button onClick={() => setMode('artists')}>
          <MicVocal /> {t('Vai agli artisti')}
        </button>
      ) : (
        <button onClick={() => (void openArtist(song), onClose())}>
          <MicVocal /> {t("Vai all'artista")}
        </button>
      )}
      <button onClick={() => (void openAlbum(song), onClose())}>
        <Disc3 /> {t("Vai all'album")}
      </button>
      {song.stems.length > 0 ? (
        <button
          onClick={() => {
            if (playback.now?.songId !== song.id) playback.playSong(song.id)
            store.setPlayerOpen(true)
            onClose()
          }}
        >
          <SlidersVertical /> {t('Apri il mixer delle tracce')}
        </button>
      ) : (
        <>
          <button onClick={() => (void store.splitLater(song), onClose())}><SlidersVertical /> {t('Separa le tracce (per suonarci sopra)')}</button>
          {isDownloaded(song) ? (
            <button onClick={() => (void store.removeDownload([song.id]), onClose())}>
              <CircleArrowDown /> {t('Rimuovi download')}
            </button>
          ) : (
            youtubeIdOf(song.id) && (
              <button onClick={() => (keep(), store.download([song.id]), onClose())}>
                <Download /> {t('Scarica sul dispositivo')}
              </button>
            )
          )}
        </>
      )}
      {inLib && <button onClick={() => setMode('rename')}><Pencil /> {t('Rinomina')}</button>}
      {inLib && (
        <button className="danger" onClick={() => setMode('delete')}>
          <Trash2 /> {t('Elimina dal telefono')}
        </button>
      )}
    </Sheet>
  )
}

export function PlaylistPicker({
  title,
  exclude,
  onPick,
  onClose
}: {
  title: string
  exclude?: string
  onPick: (id: string, name: string) => void
  onClose: () => void
}) {
  const store = useStore()
  const [creating, setCreating] = useState(false)
  if (creating) {
    return (
      <PromptSheet
        title={t('Nuova playlist')}
        placeholder={t('Nome della playlist')}
        confirm={t('Crea')}
        onDone={(name) => onPick(store.createPlaylist(name), name)}
        onClose={onClose}
      />
    )
  }
  const lists = store.playlists.filter((p) => p.id !== exclude)
  return (
    <Sheet title={title} onClose={onClose}>
      <button onClick={() => setCreating(true)}><Plus /> {t('Nuova playlist…')}</button>
      {lists.map((p) => (
        <button key={p.id} onClick={() => (onPick(p.id, p.name), onClose())}>
          <ListMusic /> {p.name} <span className="muted">· {p.songIds.length}</span>
        </button>
      ))}
    </Sheet>
  )
}

function AddSongs({ playlist, onClose }: { playlist: Playlist; onClose: () => void }) {
  const store = useStore()
  const [picked, setPicked] = useState<string[]>([])
  const available = store.songs.filter((s) => !playlist.songIds.includes(s.id))
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  return (
    <Sheet title={`Aggiungi a “${playlist.name}”`} onClose={onClose}>
      {available.map((s) => (
        <button key={s.id} className={`pick ${picked.includes(s.id) ? 'on' : ''}`} onClick={() => toggle(s.id)}>
          <span className="check">{picked.includes(s.id) ? <Check /> : null}</span>
          <SongThumb song={s} size={40} />
          <span className="pick-title">{s.title}</span>
        </button>
      ))}
      {!available.length && <p className="muted">{t('Ci sono già tutte le canzoni della libreria.')}</p>}
      <button
        className="primary sticky"
        disabled={!picked.length}
        onClick={() => {
          store.addToPlaylist(playlist.id, picked)
          onClose()
        }}
      >
        {t('Aggiungi')} {picked.length || ''}
      </button>
    </Sheet>
  )
}

/** Spotify's download switch for a whole list: saves the songs that stream, or frees them */
function DownloadToggle({ songs }: { songs: Song[] }) {
  const store = useStore()
  const [asking, setAsking] = useState(false)
  const streamable = songs.filter((s) => !s.stems.length && youtubeIdOf(s.id))
  if (!streamable.length) return null
  const missing = streamable.filter((s) => !isDownloaded(s))
  const busy = streamable.filter((s) => store.downloading.includes(s.id)).length
  const all = missing.length === 0
  return (
    <>
      <button
        className={`dl-toggle ${all ? 'on' : ''}`}
        onClick={() => (all ? setAsking(true) : store.download(missing.map((s) => s.id)))}
        aria-label={all ? t('Rimuovi i download') : t('Scarica tutti')}
      >
        {all ? <CircleArrowDown /> : <Download />}
        {busy ? ` ${streamable.length - missing.length}/${streamable.length}` : ''}
      </button>
      {asking && (
        <Sheet title={t('Rimuovere i download?')} onClose={() => setAsking(false)}>
          <p className="muted">
            {t('I brani tornano in streaming e restano nella libreria e nelle playlist; senza internet non si possono ascoltare. Le tracce separate restano scaricate.')}
          </p>
          <button className="danger solid" onClick={() => (void store.removeDownload(streamable.map((s) => s.id)), setAsking(false))}>
            {t('Rimuovi download')}
          </button>
          <button onClick={() => setAsking(false)}>{t('Annulla')}</button>
        </Sheet>
      )}
    </>
  )
}
