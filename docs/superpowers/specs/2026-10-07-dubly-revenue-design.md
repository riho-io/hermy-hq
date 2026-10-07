# Etapp 4a — dubly.me tulud Jarvises

**Kuupäev:** 2026-10-07 · **Seis:** disain kinnitatud (Riho).

Etapp 4 („Raha") on jagatud tükkideks: **4a dubly.me tulud** (see dokument), hiljem kulud kulu-äpist, tehnika kulud
(Argo LLM, dubly provider-kulu, püsikulud) ja Sisumi kulude allikas.

## Eesmärk

Jarvises näha dubly.me (Sisum OÜ Stripe konto) tulu:
- **maksed täna** — arv + neto (TODAY-ribal, asendab „Stripe ühendamata");
- **see kuu ja eelmine kuu** — neto, bruto sulgudes;
- **MRR ja aktiivsed tellijad**, see kuu tühistatud;
- **viimased maksed** — summa, neto, liik (makse / tagasimakse / vaidlus), aeg. **Ilma kliendi andmeteta.**

## Lähenemine (Riho 07.10)

Jarvise server küsib Stripe'ilt ise, tulemus 10 min vahemälus (`unstable_cache`, töötab Next 16-s ilma Cache Components'ita).
Võti **ainult Vercelis** (`STRIPE_DUBLY_READ_KEY`, sensitive, Production). Argosse võtit ei panda (agent jookseb seal sama
kasutajana). Uut tabelit, croni ega webhooki pole.

## Andmed

- `GET /v1/balance_transactions?created[gte]=<eelmise kuu algus Tallinnas>` — kõik leheküljed (max 20 × 100).
  Arvestatakse `reporting_category`: `charge` (+, loendatakse maksena), `refund` (−), `dispute` (−). Muud (payout, stripe_fee…) välja.
  Neto = `net` (pärast Stripe tasusid), bruto = `amount`.
- `GET /v1/subscriptions?status=active` ja `status=past_due` → MRR = Σ `price.unit_amount × quantity`, teisendatud kuuks
  (year ÷ 12, week × 52/12, day × 365/12, jagatud `interval_count`-iga). Allahindlusi ei arvestata (MRR on ligikaudne).
- `GET /v1/subscriptions?status=canceled` → tühistatud see kuu = `canceled_at` ≥ selle kuu algus.
- Päeva- ja kuupiirid Tallinna aja järgi. Mitu valuutat → summad valuuta kaupa, kokku ei liideta.

## Üksused

| Fail | Vastutus |
|---|---|
| `src/lib/stripe-read.ts` | puhas: Tallinna piirid, `summarizeRevenue`, `readDublyStripe(key, now, fetch)` lehekülgede kaupa. Ei loe env-i. |
| `src/lib/stripe-read.test.ts` | `node:test` + võlts-`fetch` |
| `src/lib/stripe-dubly.ts` | `import 'server-only'`; loeb võtme, `unstable_cache` 600 s, tagastab `off` / `error` / `ok` |
| `src/lib/jarvis.ts`, `src/app/(jarvis)/page.tsx` | TODAY-lahter, allikas „Stripe · dubly.me", plokk „Raha · dubly.me" |

Uus pakett: `server-only` (Next.js ametlik, ~0 kB) — et võtmega moodul ei saaks kliendi bundle'isse sattuda.

## Vead ja servajuhud

- Võtit pole → `off`: lahter „—" + „Stripe ühendamata", allikas hall.
- Võti algab `sk_` (täisõigusega) → `error`, logi „kasuta restricted key't"; ei kasutata.
- Stripe vastab veaga / ajalõpp → `error`: lahter „—" + „Stripe viga", allikas kollane. Logisse ainult tee + HTTP kood, mitte võti.
  Viga vahemällu ei jää (cached funktsioon viskab).
- Üle 20 lehekülje → viga (mitte vaikne poolik summa).

## Turvalisus

- Restricted key, ainult lugemine: **Balance: Read**, **Subscriptions: Read**. Muud õigused välja.
- Kliendi ID-d, nimed, e-postid ja `description` ei jõua lehele — kliendikomponendile antakse ainult koondarvud ja
  viimaste maksete summad/ajad.
- Repo avalik: koodis ei võtit ega konto ID-d.

## Valmis, kui

1. Testid läbivad (piirid DST-päeval, MRR teisendus, tagasimakse miinus, mitu valuutat, lehekülgede kaupa, `sk_` keeld).
2. Prodis: see kuu neto klapib Stripe dashboardi Balance → sama perioodi netoga; MRR ±allahindlused Stripe Billing MRR-iga.
3. Ilma võtmeta leht ei kuku, näitab „ühendamata".

## Väljas (YAGNI)

Kvartali vaade, graafikud, toote/paketi nimed (vajaks lisapäringuid), teised Stripe kontod, tulu salvestamine DB-sse.
