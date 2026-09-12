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

/** Builds the final system prompt, with any user-configured extra guidance. */
export function buildSystemPrompt(extraInstructions?: string | null): string {
  const extra = extraInstructions?.trim();
  if (!extra) return RECEIPT_SYSTEM_PROMPT;
  return `${RECEIPT_SYSTEM_PROMPT}\n\nAdditional instructions from the user:\n${extra}`;
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
