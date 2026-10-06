# CURRENT — hermy-hq → „Jarvis"

**Uuendatud:** 2026-10-06 · **Seis:** plaan, koodi pole alustatud. Riho vaatab üle → siis etapp 1.

## Eesmärk

Ehitada Lead Gen Jay „Jarvise" koopia: agendi oma andmed Supabase'is + üks leht, kust on näha kõik korraga.
Põhimõte (Riho 06.10): **võtame üle maksimaalselt seda, mida Jay näitas. Mida vaja pole, eemaldame hiljem. Mida on puudu, lisame.**
Olemasolevad 25 lehte jäävad alles.

Allikas: video `YHAoNaYW-Dk` kaadrid 01:08, 01:50, 09:20 → `V:/projects/wiki/references/videos/hermes-agent-ai-tootaja-hetzner-tooriistad.md`, sektsioon „Armatuurlauad lähivaates".

## Mida Jay näitas → mis meil selle asemel on

Jarvis on **üks hele leht, viis plokki**:

| # | Jay plokk | Mis seal on | Meie vaste (ettepanek) | Andmed tulevad |
|---|---|---|---|---|
| 1 | **TODAY riba** | 3 äri-numbrit tänasest (leads, calls, payments $200+) + „12 in window / 0 stale" | **Kinnitatud 06.10:** PML päringud täna (`m_tark.inquiries`), dubly.me maksed täna, kontojääk (`konto_check`) **+ väljaminekud täna**. Lisame jooksvalt | Supabase päringud + Argo push |
| 2 | **CONNECTED APPS** | Kaart iga allika kohta, roheline kui viimane katse õnnestus oodatud aja sees | Argo/Hermes, GitHub, Supabase, postkastid (9), Telegram, wiki, konto_check, Vercel, Stripe | Iga allikas raporteerib „õnnestus / ebaõnnestus, millal" |
| 3 | **THE MACHINE** | Obsidiani vaulti graaf: märkmed, lingid, lahendamata lingid, värvid kategooria järgi, klõps avab Obsidianis | **Kaks wikit eri värviga** (Riho 06.10): PC `V:/projects/wiki` + Argo `~/.hermes/wiki`. Kategooria = ülemkaust | PC-skript + Argo-skript saadavad kumbki oma graafi |
| 4 | **HERMES AGENT** kaart | Jobide arv, „reported Xh ago", Next / Last done / Currently failing, kõigi jobide nimekiri ajakavaga | Argo 19 cronit samal kujul | Argo saadab iga croni jooksu |
| 5a | **QUARTER SALES LEADERS** | Müüjad + kvartali müük | Kvartali tulud äri kaupa (PML, dubly.me, …) | Stripe / käsitsi / hiljem |
| 5b | **LEAD INVENTORY** | Lead-andmebaaside suurus allika kaupa + päeva muutus | **Edasi lükatud** (Riho 06.10: tulevikus). Plokk jääb kujunduses tühjaks kohaks | — |
| 6 | *(Jay-l pole)* **VÄLJAMINEKUD** | — | Täna + see kuu, kategooriate kaupa, trend vs eelmine kuu | `kulu.receipts` (255 tšekki, elus, kategooriatega) + LLM/API kulud Argost + püsikulud (Vercel, Hetzner, Supabase …) |

**Hermese enda armatuurlaud** (Jay: `127.0.0.1:9119` — Chat, Sessions, Files, Models, Logs, Cron, Skills, Plugins, MCP, Channels, Webhooks, Pairing, Profiles, Config, Kanban) on **Hermese sisseehitatud osa, mitte Jay ehitatud**.
→ Seda **ei ehita** hermy-hq-sse uuesti. Kontrollida, kas Argo Hermes v0.21.5 pakub sama (SSH-tunneliga ligipääs). Olemasolevad `/hermes`, `/skills`, `/channels`, `/journey` lehed jäävad alles ja saavad andmed etapist 1.

## Andmevoog

```
Argo (cronid, skriptid) ──POST + salajane võti──► hermy-hq /api/ingest/* ──Prisma──► Supabase `hermyhq`
PC (wiki-skript)        ──POST + salajane võti──►        〃
Supabase teised skeemid (m_tark, kulu …) ──otse lugemine serveris──► Jarvise leht
```

- Agent ainult **saadab**, leht ainult **näitab**. Leht ei käivita agenti (seda teeb hiljem etapp 5).
- Bridge'i (`bridge.mjs`) pole selleks vaja. Selle 9 `DataStore` võtit asendatakse ingest-andmetega.
- Kõik uued tabelid skeemis `hermyhq` (Prisma). Skeem pole REST API-s avatud. RLS lülitatakse sisse kaitseks (Prisma roll on omanik, teda see ei piira).
- Vana `hermy_hq` skeem (RLS sees, viimane kirje 10.08) jääb puutumata. Kustutada hiljem eraldi otsusega.

## Etapid

| Etapp | Mis | Valmis, kui |
|---|---|---|
| **1. Vooluahel** | Tabelid `SourceHeartbeat`, `JobRun`, `JobSpec`; endpoint `/api/ingest/heartbeat` + `/api/ingest/job-run`; Argo wrapper, mis raporteerib iga croni lõpus | Päris Argo croni jooks ilmub DB-sse < 1 min jooksul. Vale võtmega päring → 401, midagi ei kirjutata |
| **2. Jarvise leht** | Uus avaleht või `/jarvis`: TODAY riba, CONNECTED APPS, HERMES AGENT kaart | Leht näitab päris andmeid. Peatatud cron muutub punaseks, kui ta oodatud aja sees ei jookse |
| **3. THE MACHINE** | Wiki-skript → `/api/ingest/graph` → graafivaade (märkmed, lingid, lahendamata, kategooriad, klõps → `obsidian://`) | Arvud klapivad wiki tegeliku failide arvuga |
| **4. Raha** | Väljaminekud (`kulu.receipts` + LLM/API + püsikulud) ja tulud (dubly.me Stripe jne). Allikad ükshaaval | Väljaminekute kuusumma klapib kulu-äpi omaga |
| **5. Juhtimine** | Kinnitused, Kanbanist käivitamine, Chat | **Eeldab auditi p. 2–6** (`V:/projects/hermes/docs/hermy-hq-audit-2026-09-24.md`) + negatiivset testi: ilma kinnituseta agent ei käivitu |

## Turvatingimused (kehtivad igas etapis)

- Ingest-endpoint: oma võti (`INGEST_SECRET`, mitte `INTERNAL_API_SECRET`), konstantse ajaga võrdlus, Zod, pikkuspiirangud igale väljale, korduskaitse unikaalse võtmega.
- Võti ainult Doppleris (Argo) ja Vercelis. Mitte koodis, mitte `NEXT_PUBLIC_`.
- Klient ei saa ise määrata, milline allikas ta on. Iga allika jaoks eraldi võti või allikas tuletatakse võtmest.
- Uus tabel → RLS samas migratsioonis.
- Repo on avalik: ei ühtegi päris e-posti, ID-d ega URL-i koodi.
- Teiste skeemide lugemine (`kulu`, `m_tark`): rollile `hermyhq` ainult `SELECT` konkreetsetele tabelitele või vaatele. **Mitte** anon-poliitikat ega service-role võtit.

## Otsused (Riho 06.10)

1. TODAY riba: PML päringud, dubly.me maksed, kontojääk + **väljaminekud** (Jay-l pole).
2. Wiki graaf: mõlemad wikid, eri värviga.
3. Lead-inventuur: hiljem.
4. Asukoht (CC soovitus, Riho nõus „vist avalehele"): **ehitada `/jarvis` alla, avalehele `/` tõsta, kui etapp 2 näitab päris andmeid.** Praegune Töölaud kolib `/toolaud` alla ja jääb menüüsse. Põhjus: avaleht ei ole ehituse ajal pooltühi ja vahetus on üks ümbersuunamine.

5. Väljaminekud: `kulu.receipts` ainult organisatsioon **Sisum OÜ** (dubly.me).
6. Tulud: dubly.me Stripe = Sisum OÜ konto → lugemisõigusega (restricted) võti.

## Etapp 1 — seis 06.10

Kontrollitud serverist:
- Hermese dashboard on olemas: `hermes dashboard` (port 9119, ainult 127.0.0.1, ligipääs SSH-tunneliga). Ei ehita uuesti.
- Igat croni muuta pole vaja: `~/.hermes/cron/jobs.json` (seis) + `executions.db` (1000 viimast jooksu, `cron_incidents`).
  Üks skript-cron loeb need ja saadab edasi.

Tehtud (commitimata):
- [x] DB: `hermyhq.agent_job`, `agent_job_run`, `source_heartbeat` — RLS sees samas migratsioonis, poliitikad ainult rollile `hermyhq`
  (omanikuks seada ei saanud: `postgres` ei tohi `SET ROLE hermyhq`). Kontrollitud: anon SELECT = false, advisor ei leia midagi.
- [x] Prisma mudelid `AgentJob`, `AgentJobRun`, `SourceHeartbeat`.
- [x] `POST /api/ingest/hermes-cron` — `x-ingest-secret` (konstantse ajaga), Zod, 1 MB piir, ID regex, vead lõigatakse 2000 märgini.
  Test kohapeal päris andmetega: ilma võtmeta 401, vale võti 401, vigane JSON 400, võõras `source` 400, `../x` ID 400, päris andmed läbivad valideerimise.
- [x] `scripts/argo/hermy_cron_sync.py` — loeb ainult, prindib ainult oleku muutumisel. Lugemisosa testitud serveris: 19 tööd, 7 jooksu, 7,6 kB.

Ootab Riho luba (väljapoole minevad sammud):
- [ ] Commit + push `main` → Verceli deploy.
- [ ] `INGEST_SECRET` genereerida → Vercel (Production) + Doppler `hermes/prd` → `systemctl --user restart hermes-secrets hermes-gateway`.
- [ ] Skript `~/.hermes/scripts/` alla + no-agent cron `every 5m`.
- [ ] Kontroll: päris jooks ilmub `hermyhq.agent_job_run`-i; Telegrami ei tule ühtegi sõnumit, kui kõik töötab.

Kõrvalleiud (mitte selle töö osa):
- `middleware.ts` → Next 16 nimi on `proxy.ts`. Eraldi muudatus.
- `konto-check` ja middleware'i `x-internal-secret` kasutavad veel `===` võrdlust (mitte konstantse ajaga). Eraldi parandus.
- Supabase `projektid`: loader'i `set_plan_by_email` jt anon-le kutsutavad — juba teada, `task_14eff2a7`.

## AI-võimalused (scan)

- Graafi kategooriad: **mitte AI**. Ülemkaust annab kategooria tasuta.
- „Currently failing" seletus: croni viga → üks lause, miks. Odav (1 kõne vea kohta, ainult siis, kui viga on). **Hiljem**, kui etapp 2 töötab.
- Lead-inventuuri / päringute klassifitseerimine: Jev (kui 5b tuleb). Mitte enne.
