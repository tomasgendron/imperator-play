// What a viewer may see (PLAN 8.1, 9, 6.1). Hot-seat uses the public view for the shared screen and the owner's view for a revealed hand.
import { clone } from './state.js';

/** Events as one viewer sees them: `priv` is dropped unless the viewer is in `privTo`. */
export function redactEvents(events, viewerId) {
  return events.map(e => {
    const mine = e.priv && viewerId && e.privTo.includes(viewerId);
    return { seq: e.seq, turn: e.turn, type: e.type, actor: e.actor, rule: e.rule, pub: e.pub, ...(mine ? { priv: e.priv } : {}) };
  });
}

/**
 * The state as `viewerId` may see it: no RNG, no deck order (only sizes), other players' hands replaced by {hidden:true, count},
 * the card registry reduced to the cards the viewer can see. `viewerId: null` is the public (spectator) view.
 * Saved Road/Wall cards and cards in play are public (Q48).
 */
export function viewFor(state, data, viewerId = null) {
  const v = clone(state);
  delete v.rng;
  const visible = new Set();
  for (const p of v.players) {
    for (const c of p.inPlay) visible.add(c.uid);
    for (const c of p.savedResources) visible.add(c.uid);
    if (p.id === viewerId) { for (const c of p.hand) visible.add(c.uid); }
    else p.hand = { hidden: true, count: p.hand.length };
  }
  v.decks = Object.fromEntries(Object.entries(state.decks).map(([k, d]) => [k, { count: d.length }]));
  v.cards = Object.fromEntries([...visible].sort().map(uid => [uid, state.cards[uid]]));
  v.log = redactEvents(state.log, viewerId);
  v.viewer = viewerId;
  return v;
}
