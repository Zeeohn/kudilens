# KudiLens

**Verified books for market traders, from a photo of their sales book or a voice note: in English, Pidgin, Yorùbá, Hausa or Igbo, on Telegram (and WhatsApp, on Meta's invite-only test number for now).**

Nigeria has 39.7 million micro, small and medium businesses, 96.9% of them micro (NBS/SMEDAN MSME survey, 2020 data), and most keep their records in exercise books. Without records they can't prove their income, so they can't borrow. KudiLens is a bookkeeping agent: the trader sends a photo of the page or speaks a voice note, KudiLens reads it, **checks every number**, and the trader confirms with one tap. Confirmed entries go into a double-entry ledger sealed with a hash chain, which the trader can share with a lender as a **Kudi Passport**.

> Try it: open [@KudiLensBot](https://t.me/KudiLensBot) on Telegram and send one of the [sample pages](eval/samples/) (or your own).

## The idea in one line: the models propose, code verifies

| Step | Who does it |
|---|---|
| Read the page photo into structured lines (item, quantity, price, paid/owed, customer, box on the page) | **Muse Spark 1.3** (vision, strict JSON schema) |
| Listen to a voice note in Pidgin / Yorùbá / Hausa / Igbo, transcribe and translate | **Muse Spark** native audio. Muse Voice Transcribe has no Nigerian languages, so only traders who chose English go to it first (falling back to Spark if it hears fewer than 3 words); everyone else goes straight to Spark |
| Count stock from any shop photo (shelves, sachet strips on a wall, crates), no caption or labels needed | **SAM 3.1** finds every unit it can see (whole photo plus six overlapping sections); **Muse Spark** names each unit from cut-out tiles and also counts stacks by their layers; code takes the larger count per item, and the trader can correct any number ("salt 45") |
| WhatsApp-status flyer of today's stock and prices | **Muse Image** |
| Answer "who owes me?", "how was this week?" | **Muse Spark** agent with read-only tools over the ledger |
| Arithmetic, debts, duplicates, dates, confidence gate | deterministic code (`src/verify.ts`) |
| **Find the misread digit** using the trader's own handwritten page total | deterministic code: tries every confusable digit (5↔6, 1↔7, 3↔8 …) and, for lines that were hard to read, a dropped or extra zero; uses quantity × price as a second witness. If no single misreading explains the difference, it tells the trader the written total looks wrong |
| Post to the ledger | only after the trader confirms; balanced double entry in integer kobo (`src/ledger.ts`) |
| Tamper evidence | each confirmed entry is hashed with the previous hash and the SHA-256 of its photo/voice note; the lender's "Verify" button recomputes the chain |

Nothing a model says is written to the books until code has checked it and the trader has confirmed it.

## What the trader can do

- 📸 **Photo of a page** → numbered boxes on the photo + proposed lines with warnings → ✅ Save / ✏️ Fix ("line 2 na 6,500") / 🗑️ Discard
- 🔧 **"I read ₦5,500 but your total says ₦14,700. Was it ₦6,500?"**: one tap
- 🎙️ **Voice note**: "I sell 2 bags rice give Mama Tunde, ₦50,000, she go pay Friday" → credit sale due Friday
- 💬 **Questions**: "who dey owe me pass?" → the agent answers from the ledger
- `/today` `/week`: summary + one practical tip · `/debtors`: who owes you, with polite reminders to forward on WhatsApp
- 🛒 **Photo of the shop** (or `/stock`): counts per item, with the change since the last count; reply "salt 45" to correct one · `/flyer`: status flyer
- `/passport`: a link for a lender (no customer names), revocable · `/deleteme`: erase everything

## Accuracy (honest numbers)

- **Field test** (Lagos, 31 Oct – 2 Nov, a trader's own phone): [eval/FIELD-TEST.md](eval/FIELD-TEST.md). 9/9 page lines saved with no edits; voice-note entries saved without the Fix button; stock counts against a count by eye; the five bugs the field test found and how they were fixed.
- **Eval harness:** [eval/results.md](eval/results.md); run `node --env-file=.env eval/run.ts`. 46/46 lines read exactly on 6 pages; every total check right, including two pages where the trader's own sum was wrong. Simulated misreads: 38.5% repaired automatically, 60% flagged for the trader, 1.5% wrong repairs. When unsure, KudiLens asks rather than guesses.
- Real trader pages and voice notes are scored from `eval/private/` (never committed); only aggregate numbers are published. These are small samples: they show the pipeline works on real handwriting, not a general accuracy rate.

## Run it

Node 24+, ffmpeg. No npm dependencies.

```bash
cp .env.example .env   # add MODEL_API_KEY and TG_TOKEN (WhatsApp: docs/WHATSAPP-SETUP.md)
npm test               # 42 tests, no network
npm start              # Telegram (long polling) + web on :8080
```

Deploy to any Ubuntu VM: `deploy/deploy.sh <ssh-host> <ip> --setup` (Node, ffmpeg, Caddy with automatic HTTPS, systemd).

## Layout

```
src/main.ts       start-up: reads .env, wires the channels, the app and the web server
src/app.ts        the conversation, shared by every channel: photos, voice, text, buttons, stock
src/extract.ts    Muse Spark page / voice / text → proposed entries (strict JSON schemas)
src/verify.ts     deterministic checks, page-total reconciliation, digit repair
src/ledger.ts     SQLite double-entry ledger, hash chain, passports, stock counts
src/agent.ts      tool-calling agent over the ledger (read-only)
src/meta.ts       Meta Model API client (fetch only; retries, SAM parsing)
src/media.ts      ffmpeg: voice notes to WAV, boxes on photos, crops and tile sheets
src/money.ts      naira ↔ integer kobo
src/i18n.ts       interface text: English, Pidgin (+ model drafts for Yorùbá, Hausa, Igbo)
src/channels/     telegram.ts (long polling), whatsapp.ts (Cloud API webhook, signed)
src/web.ts        Kudi Passport page + live chain verification, landing page, WhatsApp webhook
scripts/          tamper-demo.ts (edit a sealed record, watch Verify catch it), wa-check.ts, probes
deploy/           one-time server setup (Node, ffmpeg, Caddy HTTPS, systemd) and deploy
eval/             accuracy harness, synthetic samples, field-test report
```

## Privacy and safety

- Trader data stays on our server; Meta API calls use Standard mode (not Contributor), so it is not used for training.
- The passport shows totals only, never customer names; the link can be cancelled anytime; `/deleteme` erases all data and files.
- Photos that turn out to be neither a book page nor goods are deleted straight after reading.
- Reminders are drafted for the trader to forward; KudiLens never messages their customers.
- WhatsApp webhooks are verified with the app secret (HMAC-SHA256); the public bot is rate-limited per trader.
- The hash chain catches any change to, or removal of, an earlier record. On its own it can't catch someone deleting the newest record or rebuilding the whole chain; the seal code the trader receives in chat each time they save is what the latest seal on the passport can be compared against.

Built during the Meta Global AI Developer Hackathon (27 Oct – 4 Nov 2026). Apache-2.0.
