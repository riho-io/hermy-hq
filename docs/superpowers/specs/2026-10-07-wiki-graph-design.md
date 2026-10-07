# Etapp 3 — „Masin": wiki graaf Jarvises

**Kuupäev:** 2026-10-07 · **Seis:** disain kinnitatud (Riho), spec ülevaatusel.

## Eesmärk

Jarvise lehele plokk, kust näeb korraga:
1. **ülevaadet ja tervist** — kui suur ja seotud wiki on, lahendamata lingid, üksikud märkmed;
2. **navigeerimist** — klõps märkmel avab selle Obsidianis;
3. **mis muutus** — viimati muudetud märkmed ja kes muutis (PC/Claude Code või Argo/Hermes).

## Oluline fakt (kontrollitud 07.10)

PC `V:/projects/wiki` ja Argo `~/wiki` on **üks vault**, Syncthing sünkib (kaust `wiki`, `.stfolder` mõlemas).
Failinimekiri klapib 453/453 (v.a `.stversions/`). `~/.hermes/wiki` ei ole olemas.
→ Plaanitud „kaks wikit" asendub ühe graafiga, kus **värv näitab, kes märget viimati muutis**.

Syncthingi kohalik REST API Argos (`127.0.0.1:8384`, `GET /rest/db/file?folder=wiki&file=<tee>`) annab iga faili
kohta `global.modifiedBy` = seadme lühi-ID. Seadmed: `OZUULIP` = PC, `OQLFCWC` = Argo. Testitud `hot.md` peal.

## Arhitektuur

```
Argo: Hermese skript-cron (iga 60 min, no-agent)
  wiki_graph_sync.py
    ├─ loeb ~/wiki/**/*.md  (pealkiri, kaust, mtime, [[lingid]])
    ├─ küsib Syncthingilt iga faili modifiedBy + PC viimase ühenduse aja
    └─ POST /api/ingest/wiki-graph  (x-ingest-secret = INGEST_SECRET)
           └─ Prisma → hermyhq.wiki_snapshot (üks rida, asendatakse)
                     + hermyhq.source_heartbeat ('wiki')
Jarvis /jarvis  → loeb wiki_snapshot → arvud + „Viimati muudetud" (server)
                                     → graaf (force-graph, ainult kliendis)
```

PC-s midagi ei jookse. Argo on alati sees ja näeb kogu vaulti.

## Üksused

### 1. `scripts/argo/wiki_graph_sync.py` (paigaldatakse `~/.hermes/scripts/`)
- Käib läbi `~/wiki` kõik `.md` failid. Vahele jäetakse: `.stversions/`, `.git/`, `.obsidian/`, `.trash/`, `.skills/`,
  failid `*.bak*`.
- Iga märkme kohta: `id` = suhteline tee (`/`-ga), `title` = failinimi ilma `.md`-ta, `folder` = esimene kaust
  (juurfailidel `""`), `mtime` (ISO), `links` = lingitud märkmete `id`-d, `editedBy` = `pc` | `argo` | `null`.
- Lingi parsimine: `[[Nimi]]`, `[[Nimi|alias]]`, `[[Nimi#pealkiri]]`, `[[kaust/Nimi]]`; koodiplokid (```) jäetakse vahele.
  Lahendamine nagu Obsidianis: täpne tee, muidu failinimi (mitme vaste korral lühim tee).
  Leidmata → `unresolved` loendisse (`{from, target}`), graafis „kummitussõlm".
- **Märkme sisu ei saadeta.** Ainult pealkirjad, teed, lingid, ajad.
- Syncthingi API võti loetakse `~/.local/state/syncthing/config.xml`-ist, ei prindita kuhugi.
  Kui Syncthing ei vasta → `editedBy: null` kõigile, sünk jätkub (graaf töötab, värv „kes muutis" on hall).
- Prindib stdouti ainult vea korral (cron `--failure-deliver local` nagu `hermy_cron_sync`), Telegrami müra ei teki.

### 2. `POST /api/ingest/wiki-graph`
Sama muster nagu `hermes-cron`:
- `hasIngestSecret` (konstantse ajaga, fail-closed) → muidu 401, midagi ei kirjutata.
- Body piir 2 MB; Zod: `source: 'argo'`, `notes` max 3000, `unresolved` max 10 000, `syncthing.pcLastSeenAt` ts | null.
- `id`: max 300 märki, ei tohi sisaldada `..`, ei tohi alata `/`-ga, ainult `.md` lõpuga. `title` lõigatakse 200, `folder` 100.
- `links` iga märkme kohta max 500; lingid, mis ei viita saadetud märkmele, visatakse ära (mitte viga).
- Kirjutab ühe transaktsiooniga: `wiki_snapshot` upsert (`source = 'wiki'`) + `source_heartbeat` upsert
  (`expectedEveryMin = 180`, `detail` = „N märget").

### 3. Tabel `hermyhq.wiki_snapshot`
| veerg | tüüp |
|---|---|
| `source` | text PK (`'wiki'`) |
| `graph` | jsonb — `{notes, unresolved}` |
| `note_count`, `link_count`, `unresolved_count`, `orphan_count` | int |
| `pc_last_seen_at` | timestamptz null |
| `generated_at` | timestamptz |

Migratsioon: `create table` + `enable row level security` + poliitikad ainult rollile `hermyhq` **samas migratsioonis**
(nagu `agent_job`). Kontroll pärast: anon SELECT = false, `get_advisors(security)` puhas.

### 4. Jarvise plokk „Masin" (`src/app/jarvis/`)
- **Server** (`lib/jarvis.ts` laiendus): loeb `wiki_snapshot`, arvutab arvud ja „viimati muudetud" (10 tk mtime järgi),
  „täna muudetud N" (Tallinna aja järgi). Graafi JSON antakse kliendikomponendile propsina.
- **Arvud:** märkmeid · linke · lahendamata · üksikud · täna muudetud.
- **Graaf** (`wiki-graph.tsx`, `'use client'`, `force-graph` `dynamic import`-iga, et pakett ei koormaks muud lehte):
  - värvirežiim lülitiga: **kategooria** (ülemkaust, fikseeritud palett) / **kes muutis** (PC, Argo, teadmata);
  - kummitussõlm väike ja hall; sõlme suurus = linkide arv;
  - lüliti **sessions/** (vaikimisi peidus — 220 märget, varjaks muu);
  - hover → pealkiri + kaust + kes muutis; klõps → `obsidian://open?vault=wiki&file=<tee ilma .md>`.
- **Viimati muudetud** nimekiri: pealkiri, kaust, aeg, märk PC/Argo, klõps → Obsidian.
- Mobiilis graaf madalam (≈ 320 px) ja nimekiri graafi all.
- Ühendatud allikad: `wiki-pc` + `wiki-argo` → üks **„Wiki"** (heartbeat 180 min aken), märge „PC sünkis X tagasi".

## Vead ja servajuhud
- Snapshot puudub → plokk näitab „ühendamata", leht ei kuku.
- Snapshot vanem kui 3 h → allikas kollane, graaf näidatakse vana andmega + „seis X tagasi".
- Syncthing maas → `editedBy` null, „kes muutis" režiim hall, märge allika kaardil.
- Tühi `links` / juurfailid / täpitähed failinimes (`Õppetunnid.md`) — `obsidian://` URL kodeeritakse `encodeURIComponent`-iga.

## Turvalisus
- Repo on avalik: koodis ei ühtegi päris teed peale `~/wiki`, ei seadme-ID-sid (`OZUULIP`/`OQLFCWC` tulevad
  skripti keskkonnast / Syncthingi enda ID-st: oma ID = Argo, iga teine = PC).
- Märkmete pealkirjad jõuavad DB-sse (privaatne skeem, leht sisselogimise taga). Sisu ei jõua.
- Uut võtit ei teki — Argo kasutab olemasolevat `INGEST_SECRET`-i (Doppler `hermes/prd`).
- Uus pakett `force-graph` — Riho kinnitas 07.10.

## Testid / valmis, kui
1. Endpoint kohapeal: ilma võtmeta 401, vale võti 401, vigane JSON 400, `../x.md` id 400, 3001 märget 400, päris andmed 200.
2. Skript Argos käsitsi: märkmete arv = `find ~/wiki -name '*.md'` (samade välistustega); paar teadaolevat linki
   kontrollitud käsitsi; PC-s muudetud märge → `editedBy: pc`.
3. Cron ajastatud jooks ilmub DB-sse; Jarvises allikas „Wiki" roheline.
4. Leht prodis: arvud klapivad, lülitid töötavad, klõps avab Obsidiani, mobiilis loetav.

## Väljas (YAGNI)
- Märkme sisu, otsing, graafi ajalugu/trendid, mitu vaulti, AI-kategooriad (ülemkaust annab kategooria tasuta).
