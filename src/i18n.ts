import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Fixed interface text. English and Pidgin are written by hand; Yoruba, Hausa and Igbo
// were drafted with Muse Spark and must be checked by a native speaker before launch.
// Anything the models write (summaries, answers, reminders) is in the trader's language too.

export type Lang = 'en' | 'pcm' | 'yo' | 'ha' | 'ig';

export const LANG_NAMES: Record<Lang, string> = { en: 'English', pcm: 'Pidgin', yo: 'Yorùbá', ha: 'Hausa', ig: 'Igbo' };
export const LANG_FOR_MODEL: Record<Lang, string> = { en: 'English', pcm: 'Nigerian Pidgin', yo: 'Yoruba', ha: 'Hausa', ig: 'Igbo' };

const en = {
  welcome: '👋 Welcome to **KudiLens**: your shop books, kept for you.\n\n📸 Send a photo of your sales book page\n🎙️ Or send a voice note: "I sell 2 bags of rice to Mama Tunde, ₦50,000, she go pay Friday"\n💬 Or ask: "Who owes me?"\n\nI check every number before anything is saved, and you confirm with one tap.\n\nPrivacy: your photos and voice notes are used only to keep your books. Send /deleteme anytime to erase everything.',
  pickLang: 'Which language should I use?',
  langSet: 'Okay, I will speak English.',
  reading: '📖 Reading your page…',
  listening: '🎧 Listening…',
  counting: '📦 Counting your stock…',
  thinking: '🤔 One moment…',
  notLedger: "I couldn't find business records or goods in this photo. Send a clear photo of one book page, or of your goods, in good light.",
  nothingFound: "I didn't find any sales or expenses there. Try again, or type it like: \"sold 2 bags rice 5,000\".",
  duplicatePhoto: 'You already sent this exact photo, so I skipped it.',
  page: 'Page',
  lines: 'lines',
  owes: 'owes',
  paidPart: 'paid',
  balance: 'balance',
  totalMatches: '✅ Your written total {total} matches.',
  totalCashMatches: '✅ Your written total {total} matches the cash you received.',
  totalMismatch: "⚠️ Your written total is {written}, but the lines add up to {computed}. Please check the lines.",
  totalAmbiguous: "⚠️ Your written total is {written}, but the lines add up to {computed}. One of these is probably misread; tap ✏️ to fix it:",
  repairLine: '🔧 Line {n}: I read {from}, but your total says {total}. Was it **{to}**?',
  repairTotal: '🔧 Your total reads {from}, but the lines add up to {to}. I think the total is **{to}**.',
  needsCheck: 'Lines marked ⚠️ need your eye.',
  line: 'Line',
  confirmAll: '✅ Save',
  fix: '✏️ Fix',
  discard: '🗑️ Discard',
  yes: '✅ Yes',
  no: '❌ No',
  fixHelp: 'Type or send a voice note with what to change, e.g. "line 2 is 6,500", "remove line 4" or "Emeka owes 20,000, he will pay Friday". Your other lines stay.',
  saved: '✅ Saved {n} entries. Record #{seq} · seal {hash}',
  discarded: '🗑️ Discarded. Nothing was saved.',
  nothingPending: 'There is nothing waiting for you to confirm.',
  todayTitle: "📊 **Today's books**",
  weekTitle: '📊 **Last 7 days**',
  sales: 'Sales',
  collected: 'Cash received',
  credit: 'Sold on credit',
  expenses: 'Expenses',
  stockBought: 'Stock bought',
  net: 'Net',
  top: 'Top items',
  noEntries: 'No confirmed entries yet for this period.',
  debtorsTitle: '🧾 **Who owes you**',
  noDebtors: 'Nobody owes you. 🎉',
  remindPick: 'Tap a name to draft a polite reminder you can forward.',
  reminderReady: 'Here is a reminder you can forward to {name}:',
  shareWa: 'Send on WhatsApp',
  passportReady: '🪪 **Your Kudi Passport**\nShare this link with a lender or supplier. It shows your sales history and proves the records were not changed. Customer names are never shown.\n\n{url}\n\nMaking a new link cancels the old one. /passportoff cancels it now.',
  passportOff: 'Your passport link is cancelled.',
  stockPrompt: '📦 Send a photo of your shelf and I will count what is on it.',
  stockResult: '📦 **Stock count**',
  stockNone: "I couldn't recognise stock items in this photo. Try a wider, brighter photo of the shelf.",
  flyerMaking: '🎨 Making your WhatsApp status flyer…',
  flyerNeedsStock: 'Count your stock first: send a photo of your goods.',
  flyerCaption: 'Post this on your WhatsApp status to tell customers what you have today.',
  deleteAsk: '⚠️ This erases ALL your records, photos and voice notes. It cannot be undone.',
  deleteYes: 'Erase everything',
  deleted: 'Done. Everything is erased.',
  error: '😓 Something went wrong on my side. Please try again in a minute.',
  tooBig: 'That file is too large. Please send a smaller photo or a voice note under 5 minutes.',
  notHeard: "🎧 I couldn't hear that voice note clearly. Please send it again, a little closer to the phone, or type it.",
  stillOwes: 'still owes',
  fullyPaid: 'fully paid ✅',
  unknownCustomer: 'matched to',
  help: 'Things you can do:\n📸 photo of a page → I record it\n🎙️ voice note in English, Pidgin, Yorùbá, Hausa or Igbo\n/today · /week: your summary\n/debtors: who owes you + reminders\n/stock: count a shelf from a photo\n/flyer: WhatsApp status flyer\n/passport: share your records with a lender\n/language · /deleteme',
};

export type Key = keyof typeof en;

const pcm: Partial<Record<Key, string>> = {
  welcome: '👋 Welcome to **KudiLens**: we go keep your shop account for you.\n\n📸 Snap your sales book page send am\n🎙️ Or send voice note: "I sell 2 bags rice give Mama Tunde, ₦50,000, she go pay Friday"\n💬 Or ask: "Who dey owe me?"\n\nI go check every number before I save am, and you go confirm with one tap.\n\nYour pictures and voice notes na only to keep your account. Send /deleteme anytime make I clear everything.',
  pickLang: 'Which language you want make I dey use?',
  langSet: 'Oya, I go dey talk Pidgin.',
  reading: '📖 I dey read your page…',
  listening: '🎧 I dey listen…',
  counting: '📦 I dey count your goods…',
  thinking: '🤔 Small time…',
  notLedger: 'I no see any account or goods for this picture. Snap one page of your book or your goods well well for light.',
  nothingFound: 'I no see any sale or expense there. Try again, or type am like: "sold 2 bags rice 5,000".',
  duplicatePhoto: 'You don send this same picture before, so I skip am.',
  page: 'Page',
  lines: 'lines',
  owes: 'dey owe',
  paidPart: 'pay',
  balance: 'remain',
  totalMatches: '✅ The total wey you write, {total}, correct.',
  totalCashMatches: '✅ The total wey you write, {total}, match the cash wey you collect.',
  totalMismatch: '⚠️ You write total {written}, but the lines add reach {computed}. Abeg check the lines.',
  totalAmbiguous: '⚠️ You write total {written}, but the lines add reach {computed}. One of these ones fit be wrong; tap ✏️ to change am:',
  repairLine: '🔧 Line {n}: I read am as {from}, but your total talk {total}. Na **{to}**?',
  repairTotal: '🔧 Your total read {from}, but the lines add reach {to}. I think say the total na **{to}**.',
  needsCheck: 'Lines wey get ⚠️ need make you look am.',
  confirmAll: '✅ Save am',
  fix: '✏️ Change am',
  discard: '🗑️ Cancel',
  yes: '✅ Yes',
  no: '❌ No',
  fixHelp: 'Type am or send voice note of wetin to change, like "line 2 na 6,500", "comot line 4" or "Emeka own na 20,000, e go pay Friday". The other lines go still dey.',
  saved: '✅ I don save {n} entries. Record #{seq} · seal {hash}',
  discarded: '🗑️ I cancel am. Nothing save.',
  nothingPending: 'Nothing dey wait make you confirm.',
  todayTitle: '📊 **Today account**',
  weekTitle: '📊 **Last 7 days**',
  sales: 'Sales',
  collected: 'Cash wey enter',
  credit: 'Credit (dem never pay)',
  expenses: 'Expenses',
  stockBought: 'Goods wey you buy',
  net: 'Wetin remain',
  top: 'Wetin sell pass',
  noEntries: 'No entry wey you don confirm for this time.',
  debtorsTitle: '🧾 **People wey dey owe you**',
  noDebtors: 'Nobody dey owe you. 🎉',
  remindPick: 'Tap person name make I write fine reminder wey you fit forward.',
  reminderReady: 'See reminder wey you fit forward give {name}:',
  passportReady: '🪪 **Your Kudi Passport**\nGive this link to lender or supplier. E go show your sales and prove say nobody change the records. E no go show your customers names.\n\n{url}\n\nIf you make new link, the old one go cancel. /passportoff go cancel am now.',
  passportOff: 'Your passport link don cancel.',
  stockPrompt: '📦 Snap your shelf send am, I go count wetin dey there.',
  stockResult: '📦 **Goods count**',
  stockNone: 'I no fit recognise goods for this picture. Snap the shelf wide with better light.',
  flyerMaking: '🎨 I dey make your WhatsApp status flyer…',
  flyerNeedsStock: 'Count your goods first: snap your goods send am.',
  flyerCaption: 'Put this for your WhatsApp status make customers know wetin you get today.',
  deleteAsk: '⚠️ This one go clear ALL your records, pictures and voice notes. E no fit come back.',
  deleteYes: 'Clear everything',
  deleted: 'E don finish. Everything don clear.',
  error: '😓 Something spoil for my side. Abeg try again after one minute.',
  tooBig: 'That file too big. Send smaller picture or voice note wey no pass 5 minutes.',
  notHeard: '🎧 I no hear that voice note well. Abeg send am again, hold the phone close small, or type am.',
  stillOwes: 'still dey owe',
  fullyPaid: 'don pay finish ✅',
};

const TABLES: Record<Lang, Partial<Record<Key, string>>> = { en, pcm, yo: {}, ha: {}, ig: {} };

// Yoruba, Hausa and Igbo drafts (scripts/translate-ui.ts). Only keys that keep every placeholder are used.
try {
  const drafts = JSON.parse(readFileSync(join(import.meta.dirname, 'i18n-drafts.json'), 'utf8')) as Record<string, Record<string, string>>;
  for (const lang of ['yo', 'ha', 'ig'] as const) {
    for (const [k, v] of Object.entries(drafts[lang] ?? {})) {
      const placeholders = (en[k as Key] ?? '').match(/\{\w+\}/g) ?? [];
      if (k in en && placeholders.every((ph) => v.includes(ph))) TABLES[lang][k as Key] = v;
    }
  }
} catch { /* drafts are optional */ }

/** Load machine-drafted tables for yo/ha/ig if present (see scripts/translate-ui.ts). */
export function registerTable(lang: Lang, table: Partial<Record<Key, string>>): void {
  TABLES[lang] = { ...table };
}

export function t(lang: string, key: Key, vars: Record<string, string | number> = {}): string {
  const table = TABLES[(lang in TABLES ? lang : 'en') as Lang];
  let s = table[key] ?? en[key];
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export const EN = en;
