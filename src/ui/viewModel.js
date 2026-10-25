// Pure view model for the M0 scaffold page (testable in Node, no DOM): province table rows, card gallery, generals, counts.
import { validateState } from '../engine/state.js';

export const BATTLE_LABEL = 'Battle Card';

export function buildViewModel(data, state, assets) {
  const owner = id => state.players.find(p => p.id === id)?.name ?? null;
  const rows = data.provinces.map(def => {
    const p = state.provinces[def.id];
    return {
      id: def.id, name: def.name, number: p.number, reward: p.reward, owner: owner(p.owner), status: p.status,
      troops: p.id === 'roma' ? p.troops : p.owner ? p.troops : null,
      natives: p.native.count, minGarrison: null /* selectors arrive in M1 */, note: def.kind === 'roma' ? 'Roma: 10 troops, Walls on all sides, Ingrained Loyalty' : def.id === 'carthage' ? 'never a start province; 10 natives' : '',
      token: def.token, startingEligible: def.startingEligible,
    };
  });
  const cards = data.cardDefs.map(c => ({
    id: c.id, deck: c.deck, name: c.name, text: c.text, copies: c.copies, type: c.type,
    label: c.type === 'battle' ? BATTLE_LABEL : null,          // the label is driven by the card `type`, never by name (PLAN 5.2)
    artId: 'card.' + c.id, hasArt: !!assets.assets['card.' + c.id],
  }));
  const items = (data.items ?? []).map(i => ({ id: i.id, name: i.name, text: i.text, cost: i.cost.gold, artId: 'item.' + i.id, hasArt: !!assets.assets['item.' + i.id] }));
  return {
    rows, cards, items,
    generals: data.generals.map(g => ({ id: g.id, name: g.name, title: g.title, text: g.text, artId: 'general.' + g.id, tokenId: 'token.general.' + g.id })),
    counts: {
      provinces: rows.length, cardTypes: cards.length, cardsTotal: Object.keys(state.cards).length, generals: data.generals.length,
      battleCards: cards.filter(c => c.label).length, items: items.length, stateProblems: validateState(state, data),
    },
  };
}
