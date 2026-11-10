import { FileArchive, Link2, UserRound } from 'lucide-react'
import { useState } from 'react'
import { Sheet, Spinner } from '../components/ui'
import type { SpotifyList } from '../lib/engine'
import { errMsg } from '../lib/format'
import { t } from '../lib/i18n'
import { isNative, StemKitNative } from '../lib/native'
import { useImports } from '../imports'
import { useStore } from '../store'

/* "Importa playlist" (Libreria → + Playlist): from a link (Spotify, SoundCloud),
   a profile's public playlists (Spotify, SoundCloud), or Spotify's data export
   (every playlist, private ones too, and the liked songs). The imports then run
   in Libreria, one after the other (src/imports.tsx). */

type Profile = { owner: string; playlists: Array<{ name: string; url: string; count: number; image?: string }>; likes?: SpotifyList }
type Export = { playlists: SpotifyList[]; liked?: SpotifyList }

const SPOTIFY_PRIVACY = 'https://www.spotify.com/account/privacy/'

export function ImportPlaylists({ onClose }: { onClose: () => void }) {
  const store = useStore()
  const imports = useImports()
  const [link, setLink] = useState('')
  const [profileUrl, setProfileUrl] = useState('')
  const [busy, setBusy] = useState<'profile' | 'file' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [exp, setExp] = useState<Export | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const done = (n: number) => {
    store.showToast(t('Importo {count} playlist: le trovi in Libreria', { count: n }))
    onClose()
  }
  const fromLink = () => {
    const u = link.trim()
    if (!/spotify\.com\/(playlist|album)|spotify:(playlist|album):|soundcloud\.com\//.test(u)) return setErr(t('Incolla il link di una playlist Spotify o SoundCloud'))
    imports.add(u)
    store.showToast(t('Leggo la playlist: la trovi in Libreria'))
    onClose()
  }
  const findProfile = async () => {
    setErr(null)
    setBusy('profile')
    try {
      const p = await StemKitNative.importProfile({ url: profileUrl.trim() })
      setProfile(p)
      setPicked(new Set([...p.playlists.map((x) => x.url), ...(p.likes ? ['likes'] : [])]))
      if (!p.playlists.length && !p.likes) setErr(t('Questo profilo non ha playlist pubbliche'))
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(null)
    }
  }
  const pickFile = async () => {
    setErr(null)
    setBusy('file')
    try {
      const x = await StemKitNative.pickSpotifyExport()
      setExp(x)
      setPicked(new Set([...x.playlists.map((_, i) => `p${i}`), ...(x.liked ? ['liked'] : [])]))
    } catch (e) {
      const m = errMsg(e)
      if (m !== 'Annullato') setErr(m)
    } finally {
      setBusy(null)
    }
  }
  const toggle = (k: string) => setPicked((s) => {
    const n = new Set(s)
    if (n.has(k)) n.delete(k)
    else n.add(k)
    return n
  })
  const importProfile = () => {
    if (!profile) return
    let n = 0
    for (const p of profile.playlists) if (picked.has(p.url)) (imports.add(p.url, true), n++)
    if (profile.likes && picked.has('likes')) (imports.addList(profile.likes, { auto: true }), n++)
    done(n)
  }
  const importExport = () => {
    if (!exp) return
    let n = 0
    exp.playlists.forEach((p, i) => picked.has(`p${i}`) && (imports.addList(p, { auto: true }), n++))
    if (exp.liked && picked.has('liked')) (imports.addList(exp.liked, { liked: true, auto: true }), n++)
    done(n)
  }

  if (profile) {
    return (
      <Sheet title={t('Playlist di {name}', { name: profile.owner })} onClose={onClose}>
        <Checklist
          rows={[
            ...profile.playlists.map((p) => ({ key: p.url, name: p.name, sub: t('{count} brani', { count: p.count }) })),
            ...(profile.likes ? [{ key: 'likes', name: profile.likes.name, sub: t('{count} brani', { count: profile.likes.tracks.length }) }] : [])
          ]}
          picked={picked}
          toggle={toggle}
        />
        <button className="primary" disabled={!picked.size} onClick={importProfile}>
          {t('Importa {count} playlist', { count: picked.size })}
        </button>
      </Sheet>
    )
  }
  if (exp) {
    return (
      <Sheet title={t('Dal file di Spotify')} onClose={onClose}>
        <Checklist
          rows={[
            ...(exp.liked ? [{ key: 'liked', name: t('Brani che ti piacciono'), sub: t('{count} brani · diventano i tuoi preferiti', { count: exp.liked.tracks.length }) }] : []),
            ...exp.playlists.map((p, i) => ({ key: `p${i}`, name: p.name, sub: t('{count} brani', { count: p.tracks.length }) }))
          ]}
          picked={picked}
          toggle={toggle}
        />
        <button className="primary" disabled={!picked.size} onClick={importExport}>
          {t('Importa {count} playlist', { count: picked.size })}
        </button>
      </Sheet>
    )
  }

  return (
    <Sheet title={t('Importa playlist')} onClose={onClose}>
      <div className="imp-way">
        <b>
          <Link2 /> {t('Da link')}
        </b>
        <small className="muted">{t('Una playlist o un album di Spotify, o una playlist di SoundCloud.')}</small>
        <div className="imp-row">
          <input value={link} placeholder="https://open.spotify.com/playlist/…" onChange={(e) => setLink(e.target.value)} />
          <button disabled={!link.trim()} onClick={fromLink}>
            {t('Importa')}
          </button>
        </div>
      </div>

      {isNative && (
        <div className="imp-way">
          <b>
            <UserRound /> {t('Da profilo')}
          </b>
          <small className="muted">{t('Tutte le playlist pubbliche di un profilo Spotify o SoundCloud (su SoundCloud anche i suoi “Mi piace”).')}</small>
          <div className="imp-row">
            <input value={profileUrl} placeholder="https://soundcloud.com/…" onChange={(e) => setProfileUrl(e.target.value)} />
            <button disabled={!profileUrl.trim() || busy === 'profile'} onClick={() => void findProfile()}>
              {busy === 'profile' ? <Spinner /> : t('Cerca')}
            </button>
          </div>
        </div>
      )}

      {isNative && (
        <div className="imp-way">
          <b>
            <FileArchive /> {t('Da file di Spotify')}
          </b>
          <small className="muted">
            {t('Tutte le tue playlist, anche private, e i brani che ti piacciono. Chiedi i tuoi dati a Spotify ("Dati dell’account"): in qualche giorno ti arriva uno zip per email; poi sceglilo qui.')}{' '}
            <a href={SPOTIFY_PRIVACY} target="_blank" rel="noopener noreferrer">
              {t('Apri la pagina di Spotify')}
            </a>
          </small>
          <button disabled={busy === 'file'} onClick={() => void pickFile()}>
            {busy === 'file' ? <Spinner /> : t('Scegli il file (.zip)')}
          </button>
        </div>
      )}
      {err && <p className="notice error">{err}</p>}
    </Sheet>
  )
}

function Checklist({ rows, picked, toggle }: { rows: Array<{ key: string; name: string; sub: string }>; picked: Set<string>; toggle: (k: string) => void }) {
  return (
    <div className="imp-list">
      {rows.map((r) => (
        <label key={r.key} className="switch-row">
          <span>
            {r.name}
            <small className="muted block">{r.sub}</small>
          </span>
          <input type="checkbox" checked={picked.has(r.key)} onChange={() => toggle(r.key)} />
        </label>
      ))}
    </div>
  )
}
