// VotingEngine.js
// Collects votes from 3 agents, requires 2/3 consensus to fire a signal
// 2/3 = normal signal | 3/3 = STRONG signal
// Returns a signal object if consensus reached, null otherwise

import { ATR } from 'technicalindicators';
import { TwelveDataClient } from './TwelveDataClient.js';

export class VotingEngine {
  constructor() {
    this.tdClient = new TwelveDataClient();
  }

  // Takes 3 agent results and current market data, returns signal or null
  async buildSignal(pair, votes, sessionBoost = 0) {
    const buyVotes  = votes.filter(v => v.vote === 'BUY');
    const sellVotes = votes.filter(v => v.vote === 'SELL');
    const skipVotes = votes.filter(v => v.vote === 'SKIP');

    const buyCount  = buyVotes.length;
    const sellCount = sellVotes.length;

    // No consensus
    if (buyCount < 2 && sellCount < 2) {
      return null;
    }

    const direction  = buyCount >= sellCount ? 'BUY' : 'SELL';
    const voteCount  = direction === 'BUY' ? buyCount : sellCount;
    const isStrong   = voteCount === 3;
    const winningVotes = direction === 'BUY' ? buyVotes : sellVotes;

    // Average confidence of the winning agents
    const avgConfidence = Math.round(
      winningVotes.reduce((sum, v) => sum + v.confidence, 0) / winningVotes.length
    );

    // Get current price + SL/TP from 5min ATR
    const candles5m = await this.tdClient.fetchCandles(pair, '5min', 30);
    if (!candles5m || candles5m.length < 15) return null;

    const currentPrice = candles5m[candles5m.length - 1].close;
    const highs  = candles5m.map(c => c.high);
    const lows   = candles5m.map(c => c.low);
    const closes = candles5m.map(c => c.close);
    const atrVals = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });
    const atr5m = atrVals[atrVals.length - 1] || 0;

    if (atr5m === 0) return null;

    let entry, sl, tp, rr;
    if (direction === 'BUY') {
      entry = currentPrice;
      sl    = entry - (atr5m * 2.0);
      tp    = entry + (atr5m * 2.0 * 1.2);
      rr    = 1.2;
    } else {
      entry = currentPrice;
      sl    = entry + (atr5m * 2.0);
      tp    = entry - (atr5m * 2.0 * 1.2);
      rr    = 1.2;
    }

    return {
      pair,
      action: direction,
      type: 'INTRADAY',
      entry, sl, tp, rr,
      atr: atr5m,

      // Voting metadata
      voteCount,
      isStrong,
      avgConfidence,
      votes, // All 3 agent results

      // Breakdown per agent
      agentResults: votes.map(v => ({
        agent: v.agent,
        vote: v.vote,
        confidence: v.confidence,
        reason: v.reason,
      })),
    };
  }
}
