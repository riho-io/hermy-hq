# AGENTS.md — hermy-hq

## Stack

- Next.js 16.1.6 (App Router), React 19
- Tailwind CSS v4 (kõik `globals.css`-is, `tailwind.config.ts` puudub)
- npm (`package-lock.json`) — mitte pnpm
- next-auth v4 (Google OAuth + `ALLOWED_EMAILS` allowlist)
- Prisma 6 + PostgreSQL → **Supabase** projekt `projektid` (`ekjvvzlewdafnyiblrbu`, eu-central-1), skeem **`hermyhq`**
- Vercel projekt `hermy-hq` (`prj_0UHUMlRLguqOUboc170p7P7gT9tJ`), leht https://hermy-hq-tau.vercel.app/
- `hermes-bridge/bridge.mjs` — Node-protsess, mis peegeldab Hermes-agendi (Argo VPS) oleku DB-sse. **Surnud alates 13.08.**

## Versioonihaldus

- GitHub `riho-io/hermy-hq` — **AVALIK repo**. Mitte ühtegi saladust koodi ega ajalukku.
- Kohalik kaust: `V:\projects\hermy-hq-io`. (`V:\projects\hermy-hq` on vana tühi mall — ära kasuta.)
- Serveri kloon: Argo `~/vibe-projects/hermy-hq`.

## Projekti kontekst

Isiklik agendi-armatuurlaud (Riho + Hermes/Argo). Eeskuju: Lead Gen Jay video — agendil oma
taustsüsteem + „Jarvise" armatuurlaud (cronid, tulud/kulud, teadmusgraaf).
Plaan: `V:\projects\hermes\docs\plans\2026-10-06-hermy-hq-uleminek.md`.
Turvaaudit: `V:\projects\hermes\docs\hermy-hq-audit-2026-09-24.md` (tingimus 1 tehtud, 2–9 lahti).

## Andmebaas — mis kus on (kontrollitud 06.10)

- `hermyhq` skeem: Prisma tabelid, omanik roll `hermyhq`. **RLS väljas**, aga skeem pole PostgREST-is
  avatud (`pgrst.db_schemas` ei sisalda seda) ja `anon`/`authenticated` ei saa `USAGE` õigust.
  Ära lisa `hermyhq` skeemi API exposed-schemas nimekirja ega anna anon-õigusi.
- Elus andmed: `DataStore.metric-snapshots`, `konto_check`, `Reminder`. Kõik `hermes-*` võtmed külmunud 13.08.
- `hermy_hq` skeem (eraldi, RLS sees, REST-is avatud): vanem Supabase-katse — `status_snapshot`
  (jobs + spend, viimane 10.08), `briefs`, `tasks`, `approvals`. Seda repo kood ei kasuta.
- Vercelis on ka `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`, aga kood neid ei kasuta.

## Turvareeglid (lisaks `~/.claude/rules/security.md`)

- Uus tabel → `enable row level security` **samas migratsioonis**.
- Argo/serveri ligipääs DB-le = kitsas roll või üks service-role fail, mitte laiem anon-poliitika.
- Bridge'i ei taaselustata enne auditi tingimusi 2–4.
- Agendi käivitamine (`oneshot`/`chat`/`memory.write`/`onboarding.write`) ainult kinnitusjärjekorra kaudu.
- `x-internal-secret` ainult server→server, mitte kunagi `"use client"` failis.

## Koodijuhised

- GSAP keelatud — CSS scroll-driven animations + IntersectionObserver.
- Animatsioonid ainult CSS `@keyframes` / `transition`.
- Prisma jääb ORM-iks; Supabase on lihtsalt Postgres taga. `@supabase/ssr` lisada ainult põhjendatud vajadusel.

## Autentimine (dev)

- Arenduses (`NODE_ENV !== 'production'` JA `DEV_AUTH_BYPASS === 'true'`) automaatne dev-kasutaja.
- Ei tohi kunagi production-buildis aktiivne olla; Vercelis `DEV_AUTH_BYPASS` ainult Preview/Development scope'is.

## AI-first lähenemine

- Iga uue feature'i juures kaalu LLM-lahendust (kokkuvõte, klassifitseerimine, semantiline otsing).
- Paku see `docs/CURRENT.md`-sse enne implementeerimist (kulu, latentsus, UI mõju).
- Kui DB query / if-lause teeb sama töö odavamalt, ütle seda.
