# KudiLens

**Verified books for market traders, from a photo of their sales book or a voice note: in English, Pidgin, Yorùbá, Hausa or Igbo, on Telegram and WhatsApp.**

Tens of millions of Nigerian micro-businesses keep their records in exercise books. Without records they can't prove their income, so they can't borrow. KudiLens is a bookkeeping agent: the trader sends a photo of the page or speaks a voice note, KudiLens reads it, **checks every number**, and the trader confirms with one tap. Confirmed entries go into a double-entry ledger sealed with a hash chain, which the trader can share with a lender as a **Kudi Passport**.

> Try it: open [@KudiLensBot](https://t.me/KudiLensBot) on Telegram and send one of the [sample pages](eval/samples/) (or your own).

## The idea in one line: the models propose, code verifies

| Step | Who does it |
|---|---|
| Read the page photo into structured lines (item, quantity, price, paid/owed, customer, box on the page) | **Muse Spark 1.3** (vision, strict JSON schema) |
| Listen to a voice note in Pidgin / Yorùbá / Hausa / Igbo, transcribe and translate | **Muse Spark** native audio (Muse Voice Transcribe has no Nigerian languages, so English notes are routed to it and the rest to Spark) |
| Count stock on a shelf photo | **Muse Spark** names the goods; **SAM 3.1** finds and counts every instance |
| WhatsApp-status flyer of today's stock and prices | **Muse Image** |
| Answer "who owes me?", "how was this week?" | **Muse Spark** agent with read-only tools over the ledger |
| Arithmetic, debts, duplicates, dates, confidence gate | deterministic code (`src/verify.ts`) |
| **Find the misread digit** using the trader's own handwritten page total | deterministic code: tries every confusable digit (5↔6, 1↔7, 3↔8 …) and dropped zeros; uses quantity × price as a second witness |
| Post to the ledger | only after the trader confirms; balanced double entry in integer kobo (`src/ledger.ts`) |
| Tamper evidence | each confirmed entry is hashed with the previous hash and the SHA-256 of its photo/voice note; the lender's "Verify" button recomputes the chain |

Nothing a model says is written to the books until code has checked it and the trader has confirmed it.

## What the trader can do

- 📸 **Photo of a page** → numbered boxes on the photo + proposed lines with warnings → ✅ Save / ✏️ Fix ("line 2 na 6,500") / 🗑️ Discard
- 🔧 **"I read ₦5,500 but your total says ₦14,700. Was it ₦6,500?"**: one tap
- 🎙️ **Voice note**: "I sell 2 bags rice give Mama Tunde, ₦50,000, she go pay Friday" → credit sale due Friday
- 💬 **Questions**: "who dey owe me pass?" → the agent answers from the ledger
- `/today` `/week`: summary + one practical tip · `/debtors`: who owes you, with polite reminders to forward on WhatsApp
- `/stock`: shelf photo → counts per item (with change since the last count) · `/flyer`: status flyer
- `/passport`: a link for a lender (no customer names), revocable · `/deleteme`: erase everything

## Accuracy (honest numbers)

See [eval/results.md](eval/results.md); run `node --env-file=.env eval/run.ts`. Real, consented trader pages and voice notes are scored from `eval/private/` (never committed); only the aggregate numbers are published.

## Run it

Node 24+, ffmpeg. No npm dependencies.

```bash
cp .env.example .env   # add MODEL_API_KEY and TG_TOKEN (WhatsApp: docs/WHATSAPP-SETUP.md)
npm test               # 34 tests, no network
npm start              # Telegram (long polling) + web on :8080
```

Deploy to any Ubuntu VM: `deploy/deploy.sh <ssh-host> <ip> --setup` (Node, ffmpeg, Caddy with automatic HTTPS, systemd).

## Layout

```
src/verify.ts     deterministic checks, page-total reconciliation, digit repair
src/ledger.ts     SQLite double-entry ledger, hash chain, passports
src/extract.ts    Muse Spark page / voice / text → proposed entries (strict JSON schemas)
src/agent.ts      tool-calling agent over the ledger (read-only)
src/app.ts        the conversation, shared by every channel
src/channels/     telegram.ts (long polling), whatsapp.ts (Cloud API webhook, signed)
src/web.ts        Kudi Passport page + live chain verification, WhatsApp webhook
src/meta.ts       Meta Model API client (fetch only; retries, SAM parsing)
eval/             accuracy harness, synthetic samples
```

## Privacy and safety

- Trader data stays on our server; Meta API calls use Standard mode (not Contributor), so it is not used for training.
- The passport shows totals only, never customer names; the link can be cancelled anytime; `/deleteme` erases all data and files.
- Reminders are drafted for the trader to forward; KudiLens never messages their customers.
- WhatsApp webhooks are verified with the app secret (HMAC-SHA256); the public bot is rate-limited per trader.

Built during the Meta Global AI Developer Hackathon (27 Oct – 4 Nov 2026). Apache-2.0.
