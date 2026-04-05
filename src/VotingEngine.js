// VotingEngine.js — Uses pre-fetched candles, no extra API calls
// Requires 2/3 consensus. 3/3 = STRONG signal.

import { ATR } from 'technicalindicators';

export class VotingEngine {

  // candles5m passed in from voting_index — no extra fetch needed
  async buildSignal(pair, votes, candles5m, sessionBoost = 0) {
    const buyVotes  = votes.filter(v => v.vote === 'BUY');
    const sellVotes = votes.filter(v => v.vote === 'SELL');

    if (buyVotes.length < 2 && sellVotes.length < 2) return null;

    const direction    = buyVotes.length >= sellVotes.length ? 'BUY' : 'SELL';
    const winningVotes = direction === 'BUY' ? buyVotes : sellVotes;
    const voteCount    = winningVotes.length;
    const isStrong     = voteCount === 3;
    const avgConfidence = Math.round(winningVotes.reduce((s, v) => s + v.confidence, 0) / voteCount);

    // Use already-fetched 5m candles for ATR/price — zero extra API credits
    if (!candles5m || candles5m.length < 15) return null;

    const currentPrice = candles5m[candles5m.length - 1].close;
    const highs  = candles5m.map(c => c.high);
    const lows   = candles5m.map(c => c.low);
    const closes = candles5m.map(c => c.close);
    const atrVals = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    const atr5m = atrVals[atrVals.length - 1] || 0;
    if (atr5m === 0) return null;

    let entry, sl, tp;
    if (direction === 'BUY') {
      entry = currentPrice;
      sl    = entry - (atr5m * 2.0);
      tp    = entry + (atr5m * 2.0 * 1.2);
    } else {
      entry = currentPrice;
      sl    = entry + (atr5m * 2.0);
      tp    = entry - (atr5m * 2.0 * 1.2);
    }

    return {
      pair, action: direction, type: 'INTRADAY',
      entry, sl, tp, rr: 1.2, atr: atr5m,
      voteCount, isStrong, avgConfidence,
      votes,
      agentResults: votes.map(v => ({
        agent: v.agent, vote: v.vote, confidence: v.confidence, reason: v.reason,
      })),
    };
  }
}