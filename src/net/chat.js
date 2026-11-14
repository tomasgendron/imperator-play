// v31.27 (Update 2): the in-game player chat. Pure (no DOM, no net): the pages and the Node tests drive the same
// helpers. Chat is in-game only and ephemeral: messages are never written to the game log, never saved, and never
// survive a reload or a rejoin (a fresh game starts with an empty list). Transport lives on the existing PeerJS
// net channel (src/net/protocol.js 'chat', host.js relays, guest.js sends); this module only shapes the messages.
export const CHAT_EMOJIS = ['⚔️', '😂', '🎉', '🏛️', '🍇', '👑', '💀'];   // taunts and cheers: attack, laugh, celebrate, Rome, grapes, crown, skull
export const CHAT_MAX_LEN = 200;   // a chat line is short; longer text is cut, never refused
export const CHAT_CAP = 50;        // the list keeps the last 50 messages; older ones drop off

/** Text as it may be sent: trimmed, control characters stripped, capped at CHAT_MAX_LEN. '' = nothing to send. */
export function cleanChatText(text) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, CHAT_MAX_LEN);
}
/** A message to show: {from (player id), name, text, emoji}. `emoji` is true when the whole message is one of the
 *  tap-to-send emojis, so the page renders it big instead of as a small line of text. */
export function makeChatMessage({ from, name, text }) {
  const t = cleanChatText(text);
  return { from: from ?? null, name: String(name ?? '').slice(0, 20) || 'Player', text: t, emoji: CHAT_EMOJIS.includes(t) };
}
/** A message as it arrives over the net, or null when it is not one of ours (wrong shape, empty text). The host
 *  re-checks this on receipt and stamps the sender's name from its own seat table, never from the guest. */
export function validateChatMessage(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.text !== 'string') return null;
  const text = cleanChatText(m.text);
  if (!text) return null;
  return { from: typeof m.from === 'string' ? m.from : null, name: String(m.name ?? '').slice(0, 20) || 'Player', text, emoji: CHAT_EMOJIS.includes(text) };
}
/** The on-screen list: add() drops invalid/empty messages and the oldest ones past the cap. `version` ticks on
 *  every change, so a page can skip re-rendering when nothing arrived. */
export function createChatLog(cap = CHAT_CAP) {
  const log = { list: [], version: 0 };
  log.add = m => {
    const msg = m && typeof m === 'object' && 'text' in m ? validateChatMessage(m) : null;
    if (!msg) return null;
    log.list.push(msg);
    while (log.list.length > cap) log.list.shift();
    log.version++;
    return msg;
  };
  log.clear = () => { log.list = []; log.version++; };
  return log;
}
