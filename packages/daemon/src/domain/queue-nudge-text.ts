// The bare body of a queue wake nudge (create / handoff / handoff-and-complete).
// `wrapPaneEnvelope` wraps it in the From/To/---/body/---/↩ Reply envelope.
//
// When the qitem has a stored summary, the nudge carries a bounded one-line copy so
// the recipient knows what arrived without a second queue read. With the row's body
// (renderQueueWakeBody) the wake also carries up to QUEUE_WAKE_BODY_MAX_BYTES of it,
// so a seat can start on the work it describes. The durable row stays authoritative:
// rendering here never rewrites the stored summary or body.
//
// The summary is author-supplied text typed into another seat's pane, so it must not
// be able to alter the envelope or hide text in it: every control character (C0,
// DEL, C1), Unicode line/paragraph separator and invisible format character
// (zero-width, direction marks, bidi overrides, tag characters) becomes a space.
// With no line break left, the summary stays on the body line after the fixed
// "Queue handoff:" prefix and cannot forge a `---`, From:, Sent: or ↩ Reply line.

import { shellQuote } from "../adapters/shell-quote.js";

/** Longest summary the nudge carries, in code points (including the ellipsis). */
export const QUEUE_NUDGE_SUMMARY_MAX_CHARS = 120;

const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function boundSummary(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const flat = summary.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  // Array.from splits by code point so the cut never leaves half a surrogate pair.
  const chars = Array.from(flat);
  if (chars.length <= QUEUE_NUDGE_SUMMARY_MAX_CHARS) return flat;
  return `${chars.slice(0, QUEUE_NUDGE_SUMMARY_MAX_CHARS - 1).join("").trimEnd()}…`;
}

/** The nudge's body line, followed by the row's body section when the wake carries it (renderQueueWakeBody). */
export function renderQueueHandoffNudge(qitemId: string, summary: string | null | undefined, body?: QueueWakeBody): string {
  const generic = `Queue handoff: ${qitemId} - check your queue.`;
  const bounded = boundSummary(summary);
  const head = bounded === null ? generic : `${generic} Summary: ${bounded}`;
  return body ? `${head}\n${renderQueueWakeBody(qitemId, body)}` : head;
}

/** Most bytes of a row's body a wake carries, counted on the rendered block: indentation and escapes included. */
export const QUEUE_WAKE_BODY_MAX_BYTES = 4096;

/** The row's stored body, and whether erasure emptied it (an erased body isn't an empty one). `claimOnWake`: the row
 *  opted in to a claim by the wake that carries its complete body. */
export interface QueueWakeBody { text: string; erased: boolean; claimOnWake?: boolean }

/** The claim line of a wake that claims its row as it's written: the delivery writes it only once that claim is made. */
export const CLAIMED_BY_WAKE_LINE = "Claim: claimed for this seat by this wake; no rig queue claim needed";

/** Every body line is indented, so no body line can read as an envelope line (`---`, From:, ↩ Reply). */
const BODY_INDENT = "    ";
const BODY_LINE = "Body: ";

/** A body character that could act on the recipient's input or hide text there: C0 controls other than newline (tab
 *  too: a paste is bracketed only when the app asked for it), DEL and C1, invisible format characters, line and paragraph
 *  separators, and unpaired surrogates. */
const UNSAFE_BODY_CHAR = /^(?:[\x00-\x09\x0b-\x1f\x7f-\x9f\p{Cf}\p{Zl}\p{Zp}]|[\ud800-\udfff])$/u;

function escapedBodyChar(ch: string): string {
  const cp = ch.codePointAt(0)!;
  return cp <= 0xff ? `\\x${cp.toString(16).padStart(2, "0")}` : `\\u{${cp.toString(16)}}`;
}

/** The wake's body section: a completeness line, the claim line (claimed by this wake for an opted-in row whose whole
 *  body is carried, else required), and the body as an indented block of at most
 *  QUEUE_WAKE_BODY_MAX_BYTES rendered bytes. Unsafe characters are shown escaped; the cut falls between whole
 *  characters (an escape is never split), and a cut body is marked as a preview with the command that reads it all. */
export function renderQueueWakeBody(qitemId: string, body: QueueWakeBody): string {
  const claim = body.claimOnWake ? CLAIMED_BY_WAKE_LINE : `Claim: required — rig queue claim ${shellQuote(qitemId)}`;
  if (body.erased) return `${BODY_LINE}unavailable (its content was erased); not automatically claimed`;
  if (body.text === "") return `${BODY_LINE}complete (empty)\n${claim}`;
  let block = BODY_INDENT, bytes = BODY_INDENT.length, cut = false;
  for (const ch of body.text) {
    const unit = ch === "\n" ? `\n${BODY_INDENT}` : UNSAFE_BODY_CHAR.test(ch) ? escapedBodyChar(ch) : ch;
    const size = Buffer.byteLength(unit);
    if (bytes + size > QUEUE_WAKE_BODY_MAX_BYTES) { cut = true; break; }
    block += unit; bytes += size;
  }
  return cut
    ? `${BODY_LINE}preview; not automatically claimed\n${block}\nRead the rest: rig queue show ${shellQuote(qitemId)} --full`
    : `${BODY_LINE}complete\n${claim}\n${block}`;
}

/** A wake's text with its body section taken out, for a wake that goes with another one's body in the same delivery: the
 *  body line then says it wasn't included (whether the body was complete, empty or erased), and the claim stays manual.
 *  Text with no body section is returned as it is. */
export function withoutQueueWakeBody(text: string, qitemId: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex(l => l.startsWith(BODY_LINE));
  if (at < 0) return text;
  const rest = lines.slice(at + 1).filter(l => !l.startsWith(BODY_INDENT) && !l.startsWith("Read the rest: ") && !l.startsWith("Claim: "));
  return [...lines.slice(0, at), `${BODY_LINE}not included in this delivery; read it with rig queue show ${shellQuote(qitemId)} --full`,
    `Claim: required — rig queue claim ${shellQuote(qitemId)}`, ...rest].join("\n");
}
