# Field test (Lagos, 31 Oct – 2 Nov 2026)

Real shops, real phones, the live bot on Telegram. The trader agreed to take part; their photos, voice notes and numbers stay on our server and in `eval/private/` (git-ignored). Only these aggregates are published.

## A trader's own phone (2 Nov)

| What they sent | Result |
|---|---|
| 1 photo of a handwritten sales page (9 lines, ₦63,500) | All 9 lines read with the right item and amount; saved with **no edits** |
| 5 voice notes recording sales on credit and part payments | 3 entries saved, **none needed the ✏️ Fix button**; 2 of the notes were spoken follow-ups to an entry still waiting |
| 1 voice question ("who owes me?") | Answered from the ledger by the agent; a polite reminder drafted to forward |
| 1 photo of sachet strips on a wire wall, no caption | Counted by item (5 kinds); the trader can correct any number with one reply |

The interface ran in Hausa for this trader. The Yorùbá, Hausa and Igbo interface text are model drafts that a native speaker still has to review.

## Page reading (eval harness, `node --env-file=.env eval/run.ts`)

6 pages: 2 public synthetic samples and 4 field photos of one handwritten page from two phones (two of them with a wrong total written under the lines).

- Lines with the exact kind and amount: **46/46**.
- Written totals read correctly: **4/4**.
- Total check right: **4/4**, including both pages where the trader's own sum was wrong (₦50,000 written, ₦63,500 in the lines). The bot says the written total looks wrong instead of "repairing" a clearly written line.

Six pages is a small sample; these numbers show the pipeline works on real handwriting, not a general accuracy rate.

## Stock counts (2 shop photos, against our own count by eye)

| Photo | Item | KudiLens | By eye |
|---|---|---|---|
| Sachet wall | Gino Asun sachets | 26 | about 25 |
| Crowded shelf | Mr Chef salt | 52 | 40–50 |
| Crowded shelf | Pasta (two stacks) | 19 | 19 |
| Crowded shelf | Seasoning jars | 12 | 12 |
| Crowded shelf | Egg crates | 3 | 4–5 |

Counts are close, not exact: units hidden behind others can't be seen. That is why the trader can correct any count right after it ("salt 45").

## Bugs the field test found, and the fixes

| Found | Fix |
|---|---|
| A photo of goods hung on a wall was answered "caption it stock" | Every photo is now classified (book page, goods, other); goods are counted without a caption |
| Crowded shelves were badly undercounted (salt: 1) | The detector also searches six overlapping sections; Muse Spark counts stacks by their layers; the larger count is shown |
| A page with a "Total" line was read as goods bought, so the total check added up ₦0 of sales | A list of goods with amounts is read as sales unless the page says they were bought; a page with no sales is checked over all its lines |
| A wrong written total was "explained" by reading 15,000 as 1,500 | A tenfold change is only suggested for a line that was hard to read; otherwise the trader is told the total looks wrong |
| A non-business photo was kept on the server | Photos that are neither a book page nor goods are deleted straight after reading |
