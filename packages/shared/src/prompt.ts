/**
 * The extraction prompt, shared by the in-app providers and the server proxy so
 * both produce identical results.
 *
 * It is written around what actually goes wrong on Swedish receipts: thermal
 * print that drops strokes, the `Moms` table being mistaken for line items,
 * `Pant` and `Rabatt` rows being silently folded into the product above, and
 * decimal commas being read as thousands separators.
 */

/** Instructions common to every provider. */
export const RECEIPT_SYSTEM_PROMPT = `You read photographed receipts and return structured data. Most receipts are Swedish; some are English or other Nordic languages.

Transcribe, do not calculate. Every amount you return is a STRING copied exactly as printed, keeping the original decimal comma, thousands space and sign — "1 234,50", "25,00-", "-12,50". Never convert to a number, never reformat, never compute a value that is not printed. If a field is not printed on the receipt, return null for it. Do not guess, and do not carry values over from other receipts you have seen.

Read every printed line in order, including lines that are not products:
- "Pant" rows (bottle and can deposits) are their own lines. Never fold pant into the product above it.
- Discount rows ("Rabatt", "Prisnedsättning", "Extrapris", "Stammis", "Medlemsrabatt", "Kampanj") are their own lines, with a negative totalPrice.
- A "x st à 12,50" or "0,412 kg × 89,00 kr/kg" qualifier belongs to the line above: put the count in quantity, the per-unit price in unitPrice, and the line sum in totalPrice.

Do not turn the VAT summary into line items. The block near the bottom with columns like "Moms%", "Netto", "Moms", "Brutto" goes into vatLines, not items. Swedish VAT rates are 25, 12, 6 and 0 percent.

Field notes:
- total is "Att betala" (or "Totalt" / "Summa" when there is no "Att betala"). It is the amount actually paid, after öresavrundning.
- roundingAmount is the "Öresavrundning" line and can be negative.
- purchasedAt is the date and time as printed, in whatever format the receipt uses. Do not normalise it.
- name should be a readable product name: fix obvious all-caps abbreviations ("MJOLK MELLAN 1.5%" becomes "Mjölk mellan 1,5 %") but never invent detail that is not on the paper. Put the untouched printed text in rawName.
- Swedish letters matter: å, ä and ö are distinct letters. Read them as printed.

When the image is cut off, blurred or a line is genuinely unreadable, leave that field null and lower your confidence rather than inventing a plausible value. A missing field is recoverable; a wrong one is not.`;

/** The user-turn instruction that accompanies the image. */
export const RECEIPT_USER_PROMPT =
  'Read this receipt and return the structured data. Include every printed line, ' +
  'in the order it appears.';

/**
 * Extra instruction appended for providers with no structured-output support,
 * where the JSON contract has to live in the prompt itself.
 */
export function jsonOnlyInstruction(schema: unknown): string {
  return (
    'Respond with a single JSON object and nothing else — no prose, no markdown ' +
    'fence, no explanation. It must validate against this JSON Schema:\n\n' +
    `${JSON.stringify(schema)}\n`
  );
}

/**
 * A shorter system prompt for small local models.
 *
 * The full prompt is written for a frontier model: it explains *why* pant and
 * rabatt rows matter, and trusts the reader to generalise. A 4B model does not
 * generalise from rationale — it follows the last concrete instruction it read,
 * and a long preamble measurably costs it accuracy on the fields that matter.
 * So this keeps the same rules, stated as rules, and drops the reasoning.
 *
 * The JSON contract itself is not stated here at all, because a local model is
 * driven with a schema at the sampler (Ollama's `format`), which constrains the
 * output far more reliably than any wording could.
 */
export const RECEIPT_SYSTEM_PROMPT_COMPACT = `You read photographed receipts, mostly Swedish, and return structured data.

Rules:
1. Copy amounts exactly as printed, as strings: "1 234,50", "25,00-", "-12,50". Keep the decimal comma. Never calculate, never reformat.
2. Any field not printed on the receipt is null. Never guess a value.
3. Every printed line becomes an item, in order — including "Pant" rows (isDeposit true) and discount rows like "Rabatt" or "Extrapris" (isDiscount true, negative totalPrice). Never merge them into the line above.
4. A "2 st à 12,50" or "0,412 kg × 89,00 kr/kg" line belongs to the item above it: quantity, unitPrice, and the line sum as totalPrice.
5. The "Moms" table at the bottom goes in vatLines, never in items. Swedish VAT rates are 25, 12, 6 and 0.
6. total is "Att betala", or "Totalt"/"Summa" when there is no "Att betala".
7. purchasedAt is the date and time exactly as printed.
8. å, ä and ö are distinct letters. Read them as printed.

If a line is unreadable, use null for that field and lower confidence. Do not invent.`;

/**
 * The system prompt for a second, correcting pass.
 *
 * The first pass is deliberately a transcription: copy what is printed, never
 * compute, never normalise. That is the right default, because a model that is
 * allowed to reason about amounts will quietly "tidy" a receipt into something
 * that balances but is not what the paper says.
 *
 * When validation then finds the result does not add up, though, transcription
 * has already failed — and the most likely cause is mechanical and findable: a
 * misread digit, a line skipped entirely, or a pant/rabatt row folded into the
 * product above it. So this pass relaxes exactly two rules and says which, and
 * spends the rest of its words making sure the relaxation is not taken as
 * licence to invent.
 *
 * That last part is the whole risk. "Make it add up" is an instruction a model
 * can always satisfy by changing a number, and a receipt app that silently
 * adjusts amounts to balance is worse than one that admits it misread — the
 * user can correct a flagged receipt, but cannot spot a plausible wrong one.
 */
export const RECEIPT_CORRECTION_SYSTEM_PROMPT = `You are re-reading a photographed receipt that has already been transcribed once. The first attempt produced data that does not hold together, and the problems found are listed below. Your job is to look at the image again and work out what was misread.

Two rules from an ordinary transcription are relaxed here, and only these two:

1. You may reconcile. When the line items do not add up to the printed total, there is a concrete cause on the paper and you should find it. In order of likelihood: a digit misread (5/6, 3/8, 0/8 and 1/7 are the usual pairs in thermal print); a printed line missed entirely; a "Pant" or "Rabatt" row folded into the product above instead of standing as its own line; a quantity line ("2 st à 12,50") read as a separate item; a decimal comma read as a thousands separator. Look for which of these it was, and fix that line.

2. You may normalise the purchase date. If it was missing or in a shape that could not be parsed, return it as YYYY-MM-DD, or YYYY-MM-DDTHH:mm when a time is printed. Read the date off the image — do not infer it from anything else.

Everything else is unchanged. Amounts are still STRINGS copied as printed, with the original decimal comma and sign. Fields that are not printed are still null. The VAT table still goes in vatLines, never in items.

Now the part that matters most:

NEVER change a number just to make the arithmetic work. You are looking for a misreading, not balancing a ledger. If you compare the image against the reported problem and cannot see what went wrong, return what the receipt actually says and leave it not adding up — say so by lowering confidence. A receipt that is flagged as inconsistent is something the user can fix in ten seconds. A receipt that was silently adjusted into looking correct is one they will never know to check, and this is their financial record.

Do not carry over the previous attempt's values because they were there before. Re-read the image. Where the previous attempt was right, you will arrive at the same value again; where it was wrong, you will not.`;

/** What a correction pass is told about the attempt it is re-doing. */
export interface CorrectionContext {
  /** The problems validation found, in plain language. */
  problems: string[];
  /** The previous attempt's parsed JSON, so the model can see what it claimed. */
  previous: unknown;
}

/** Builds the final system prompt, with any user-configured extra guidance. */
export function buildSystemPrompt(
  extraInstructions?: string | null,
  options: { compact?: boolean; correction?: boolean } = {},
): string {
  const base = options.correction
    ? RECEIPT_CORRECTION_SYSTEM_PROMPT
    : options.compact
      ? RECEIPT_SYSTEM_PROMPT_COMPACT
      : RECEIPT_SYSTEM_PROMPT;
  const extra = extraInstructions?.trim();
  if (!extra) return base;
  return `${base}\n\nAdditional instructions from the user:\n${extra}`;
}

/**
 * The user turn for a correction pass: what went wrong, and what was said last
 * time.
 *
 * The previous attempt is included so the model can diff its own reading
 * against the image rather than starting cold — it is much easier to spot "I
 * wrote 58,00 and the paper says 53,00" than to re-derive the whole receipt.
 */
export function buildCorrectionUserPrompt(context: CorrectionContext): string {
  const problems = context.problems.map((problem) => `- ${problem}`).join('\n');
  return (
    'This receipt was read once already and the result did not hold together.\n\n' +
    `Problems found:\n${problems}\n\n` +
    `The previous attempt returned:\n${JSON.stringify(context.previous, null, 2)}\n\n` +
    'Look at the image again, work out which reading was wrong, and return the ' +
    'corrected data in the same structure. If you cannot find the mistake, return ' +
    'what the receipt actually says and leave the inconsistency in place.'
  );
}

/** The user turn for a pass, correcting or not. */
export function buildUserPrompt(correction?: CorrectionContext | null): string {
  return correction ? buildCorrectionUserPrompt(correction) : RECEIPT_USER_PROMPT;
}

/**
 * Pulls a JSON object out of a model response that may be wrapped in prose or a
 * markdown fence. Returns `null` when nothing parseable is found.
 */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  const direct = tryParse(trimmed);
  if (direct) return direct;

  // ```json ... ``` fences.
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    const parsed = tryParse(fence[1].trim());
    if (parsed) return parsed;
  }

  // Fall back to the outermost balanced { ... } in the response.
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') inString = !inString;
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return tryParse(trimmed.slice(start, index + 1));
    }
  }
  return null;
}

function tryParse(text: string): Record<string, unknown> | null {
  if (!text.startsWith('{')) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
