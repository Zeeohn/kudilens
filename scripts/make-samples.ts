// Generate synthetic sample pages with Muse Image, for judges without a ledger and for the eval.
// These are labelled synthetic; real trader pages stay in eval/private/.
import { writeFileSync } from 'node:fs';
import { Meta } from '../src/meta.ts';

const m = new Meta({ apiKey: process.env.MODEL_API_KEY ?? '' });
const style = 'Top-down phone photo of an open lined school exercise book on a wooden market table in Lagos, natural daylight, slight shadow. Handwritten in blue ballpoint pen, neat but casual Nigerian trader handwriting.';
const samples: Record<string, string> = {
  'page-sales': `${style} The page is headed "28/10/26 SALES". Lines, one per row:\n"Rice 2 bags x 2,500 = 5,000"\n"Indomie 1 carton = 7,000"\n"Mama Tunde - Beans 3 paint = 6,500 (owe)"\n"Groundnut oil 1 bottle = 1,200"\n"Garri 2 paint x 800 = 1,600"\nAt the bottom: "Total = 21,300" underlined twice.`,
  'page-debts': `${style} The page is headed "CREDIT BOOK". Lines:\n"Bisi - 2 crates egg 9,000 - paid 4,000 bal 5,000"\n"Alhaji Musa - supply 10 bags rice 25,000 (I owe)"\n"Chinedu paid 3,000 transfer"\n"Transport 1,500"\n"Nepa light 2,000"`,
  'shelf': 'Phone photo of a small provision shop shelf in a Lagos market, three wooden shelves stacked with 50kg bags of rice (white woven sacks with red print), cartons of instant noodles, and tins of tomato paste. Realistic, daylight, slightly cluttered.',
};
await Promise.all(Object.entries(samples).map(async ([name, prompt]) => {
  const t = Date.now();
  const png = await m.generateImage(prompt, name === 'shelf' ? '1536x1024' : '1024x1536');
  writeFileSync(`eval/samples/${name}.png`, png);
  console.log(name, png.length, 'bytes', Date.now() - t, 'ms');
}));
