# KudiLens — hackathon game plan (Indie track, target: top 3)

**Deadline:** Wed 4 Nov, 9:00 PM ET = **Thu 5 Nov, 03:00 Lagos time** (US clocks change on 1 Nov).
**Our internal deadline:** **Wed 4 Nov, 20:00 Lagos** — submitted, video public, repo public. No last-hour risk.

## How we win (the rubric, and our answer to each part)
| Criterion | Weight | Our answer |
|---|---|---|
| **Impact** | 30% | Nigeria's tens of millions of micro-businesses run on exercise books. Records are what lenders ask for. KudiLens turns a photo or a voice note into books a lender can verify. Proven with **real Lagos traders in a field test**, with numbers. |
| **Use of Meta AI** | 25% | Six Meta models, each doing a job only it can do (table below). Two capabilities the judges won't expect: **SAM 3.1 counting stock from a shelf photo**, and **Muse Spark understanding Yoruba/Pidgin voice notes natively** where Voice Transcribe has no support. Benchmarked, with routing between them. |
| **Technical depth** | 20% | "The model proposes, code verifies": double-entry ledger, deterministic checks, **self-repair of misread digits using the trader's own handwritten page total**, a hash-chained tamper-evident ledger bound to the photo/voice evidence, an eval harness with honest accuracy numbers, and zero npm dependencies. |
| **Demo** | 25% | Real market footage, a phone screen, and three "wow" moments: the misread-digit catch, the shelf count, and the lender verifying the passport. Live bot judges can try in 10 seconds, with sample pages for anyone without a ledger. |

**Avoid the anti-project trap:** this is *not* a "simple image analyzer". The story is an **agent that keeps verified books**, with photo and voice only as inputs. Say that in the first 20 seconds of the video.

## Meta model map
| Model | Job in KudiLens | Why this model |
|---|---|---|
| **Muse Spark 1.3** | Reads handwritten ledger pages into structured entries (with row boxes); the conversational agent with tools; summaries in the trader's language | Vision + strict JSON + tool calling |
| **Muse Spark 1.2 (audio)** | Understands voice notes in **Pidgin, Yoruba, Hausa, Igbo** directly into entries | Native audio; Meta recommends 1.2 for audio |
| **Muse Voice Transcribe** | Fast, cheap transcript of English/Nigerian-English voice notes; the benchmark baseline | $0.18/hour; but no Nigerian-language support, so we **route** |
| **SAM 3.1** | Finds the page (or each receipt) in a messy photo; **counts stock on a shelf** ("bag of rice") | Concept segmentation returns every instance |
| **Muse Image** | Makes a WhatsApp-status flyer of today's stock and prices, so traders sell more | $0.01 per image; good at text |
| **Muse Glimmer / Spark Open** (open weights via a partner) | Low-cost route for summaries and chat; a self-hostable option for cooperatives/lenders | Apache-2.0; bonus prize |
| **Muse Wonder** (stretch) | Month-end close: reconcile a month of entries and write the passport narrative | Long-horizon agent work |

## Product (priority order)
**P0 — must ship**
1. Telegram bot: send a page photo → proposed entries with flags → one-tap confirm/fix → ledger.
2. Voice note in any of the four languages → entries (routed, benchmarked).
3. Verification: maths check, page-total reconciliation with digit repair, debt/overpayment checks, duplicates, confidence gate.
4. Ledger: double entry, debtors, daily summary in the trader's language, polite debt reminders to forward.
5. **Kudi Passport**: a lender view (web) with 30/90-day sales, evidence coverage, debt collection, and a **"Verify" button** that re-checks the hash chain.
6. Eval harness + honest accuracy numbers on real pages.
7. README, architecture diagram, 3-minute video.

**P1 — the wow layer**
8. SAM 3.1 shelf count → stock snapshot.
9. Muse Image status flyer.
10. Open-weight route (Glimmer or Spark Open via Baseten/Fireworks/Modal).
11. WhatsApp channel via the Cloud API test number (Meta-native; for the field test).

**P2 — only if ahead:** Muse Wonder month-end close; "fake transfer alert" check (payment screenshot vs bank SMS).

## Timeline (Lagos time)
| Day | Claude builds | Owner does |
|---|---|---|
| **Wed 28 Oct** | ✅ ledger, verification, Meta client (25 tests). Extraction schemas, photo pipeline. | **API key + credits (blocker).** BotFather token. Oracle network fix. |
| **Thu 29 Oct** | Probe the models on real pages; photo pipeline end to end; Telegram bot v1. | Collect 30+ consented ledger photos, 10+ voice notes, 5 shelf photos. Ground truth for 10 pages. |
| **Fri 30 Oct** | Voice routing + language benchmark; agent tools; confirm/fix flow. | 17:00 watch "Fireworks / open models" session. Ask office hours about Nigerian languages. |
| **Sat 31 Oct** | Summaries, reminders, Passport web page + chain verify; deploy to Oracle. | Recruit 3–5 traders for the field test; get consent forms signed. |
| **Sun 1 Nov** | SAM shelf count, Muse Image flyer, open-weight route, WhatsApp. | **Field test day 1** (film with consent). |
| **Mon 2 Nov** | Fix field-test bugs; run the eval; numbers into the README. | **Field test day 2**; B-roll footage of the market. |
| **Tue 3 Nov** | Polish, README, diagram, video script, captions. | Record screen + voice-over; last office hours. |
| **Wed 4 Nov** | Final checks; tag `v1.0-hackathon`. | Edit video; **submit by 20:00**; post on X; rally community votes. |

## Owner tasks right now (in order)
1. **Meta Model API key** — dev.meta.ai → sign in → API keys → create. Add a payment card (needed even with credits; a pre-authorisation is released after a few days). **Submit the credit claim form** from the participant guide. Set a spend-limit alert at $150. Put the key in `kudilens/.env` as `MODEL_API_KEY=` (never paste it in chat).
2. **Telegram:** @BotFather → `/newbot` → name "KudiLens", username `KudiLensBot` (or `KudiLens_bot`) → token into `.env` as `TG_TOKEN=`.
3. **Partner credits** (for the open-weight bonus): request Baseten ($100) and Modal ($100); Fireworks if offered.
4. **Oracle:** fix port 22 (see earlier message); also allow **80 and 443** inbound, which the live demo needs.
5. **Discord:** join; office hours are 10–11 AM ET (15:00–16:00 Lagos until 31 Oct, 16:00–17:00 from 2 Nov).
6. **Data (with consent):** photos of real sales books, voice notes, shelf photos. Use the consent note below.
7. **WhatsApp (by Sat):** developers.facebook.com → Create app → add WhatsApp → test number; add your number and the field-test traders' numbers as recipients.

## Consent note (read to each trader; keep a photo of their "yes")
> "I'm testing an app that helps traders keep their books from a photo or a voice note. May I photograph pages of your sales book and record a voice note, and film you using the app, for a public demo video and to measure accuracy? I won't publish your phone number. You can say no, and you can ask me to delete everything later."
> *Pidgin:* "I dey test one app wey go help traders keep account from picture or voice note. You go gree make I snap your sales book, record voice note, and video you as you dey use am, for demo and to check say e correct? I no go show your phone number. You fit talk no, and you fit tell me make I delete am later."

**Rules for the repo:** no real trader photos or voices in the public repo unless the trader agreed to publication. Public eval samples are pages *we* write; real pages stay in `eval/private/` (git-ignored), and only aggregate accuracy is published.

## Demo video (3:00) storyboard
- **0:00–0:20** Market footage. A trader flips through a cramped exercise book. Text: "40-million-business problem: no records → no loans." (Check the exact statistic before using it.)
- **0:20–0:35** "KudiLens keeps verified books from a photo or a voice note, in Telegram, in your language."
- **0:35–1:15** Photo → entries appear with boxes on the page. **Wow 1:** the total doesn't match → "I read 5,500 but your total says 14,700 — was it 6,500?" → tap yes.
- **1:15–1:45** Yoruba voice note: "Mama Tunde gba apo iresi meji, yoo san ni Friday" → credit sale + due date. Debt reminder drafted in Yoruba.
- **1:45–2:05** **Wow 2:** shelf photo → "23 bags of rice, 14 cartons of noodles". Muse Image flyer for WhatsApp status.
- **2:05–2:35** **Wow 3:** Kudi Passport → lender scans the QR → "Verified: 412 entries, chain intact, 96% backed by photo/voice evidence."
- **2:35–2:50** Architecture: which Meta model does what; accuracy numbers from the field test.
- **2:50–3:00** Trader's quote + "Built during the hackathon: everything in this repo after 27 Oct."

## Bonus prizes we can realistically win
- **Most Viral ($20k):** a sharp X thread with the video; Nigerian tech X is large. Post Wed night, rally by Thu.
- **Community Vote ($10k):** share the gallery link in the communities you belong to (no spam).
- **Best open-weight build ($10k):** needs the Glimmer/Spark Open route served via a partner.
- **Best agentic use ($5k):** the verified-books agent qualifies.

## Risks and how we handle them
| Risk | Plan |
|---|---|
| API key blocked by card issues | Try a different card or a virtual dollar card today; ask in Discord #questions. Partner credits (Baseten) as partial fallback. |
| Handwriting accuracy is poor | Digit repair + one-tap confirm; report numbers honestly; tune prompts on real pages. |
| Nigerian languages weak | Measure on real voice notes; route per language; say plainly what works. |
| Server not reachable | Fix the Oracle network today; fallback: run the bot from this PC with a tunnel for the demo only. |
| "Simple image analyzer" label | Lead with the verified-books agent, the passport and the field test. |
