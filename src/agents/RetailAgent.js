// RetailAgent.js — Synchronous: receives pre-fetched candles, no API calls
// Philosophy: Classic retail TA — RSI, MACD, Stochastic, Bollinger Bands

import { EMA, RSI, MACD, Stochastic, BollingerBands } from 'technicalindicators';

export class RetailAgent {
  constructor() { this.name = 'RetailAgent'; }

  // candles = { candles4H, candles1H, candles15m, candles5m, candles1m }
  analyze(pair, candles) {
    try {
      const trend15m = this._getTrend(candles.candles15m);
      if (trend15m === 'NEUTRAL') return this._skip('15m trend neutral');

      const signal = this._getSignal(candles.candles5m);
      if (trend15m !== signal.bias) return this._skip(`MTF conflict: 15m=${trend15m} vs 5m=${signal.bias}`);

      let score = 0;
      const reasons = [];

      // RSI
      if (trend15m === 'BULLISH') {
        if (signal.rsi > 40 && signal.rsi < 65) { score += 25; reasons.push(`RSI ${signal.rsi.toFixed(0)} bullish zone`); }
        else if (signal.rsi <= 40) { score += 5; reasons.push(`RSI oversold`); }
      } else {
        if (signal.rsi > 35 && signal.rsi < 60) { score += 25; reasons.push(`RSI ${signal.rsi.toFixed(0)} bearish zone`); }
        else if (signal.rsi >= 60) { score += 5; reasons.push(`RSI overbought`); }
      }

      // MACD
      if (trend15m === 'BULLISH' && signal.macdHist > 0) { score += 25; reasons.push('MACD hist positive'); }
      else if (trend15m === 'BEARISH' && signal.macdHist < 0) { score += 25; reasons.push('MACD hist negative'); }

      // Stochastic
      if (trend15m === 'BULLISH' && signal.stochK > signal.stochD && signal.stochK < 80) {
        score += 20; reasons.push(`Stoch K>${signal.stochK.toFixed(0)} crossing up`);
      } else if (trend15m === 'BEARISH' && signal.stochK < signal.stochD && signal.stochK > 20) {
        score += 20; reasons.push(`Stoch K<${signal.stochK.toFixed(0)} crossing down`);
      }

      // Bollinger Bands
      if (trend15m === 'BULLISH' && signal.bbPosition === 'LOWER') { score += 15; reasons.push('Price at BB lower — bounce zone'); }
      else if (trend15m === 'BEARISH' && signal.bbPosition === 'UPPER') { score += 15; reasons.push('Price at BB upper — rejection zone'); }
      else if (signal.bbPosition === 'MIDDLE') { score += 8; reasons.push('Price mid BB'); }

      // EMA alignment
      if (trend15m === signal.bias) { score += 15; reasons.push('EMA9 > EMA21 aligned with trend'); }

      const confidence = Math.min(100, score);
      const vote = confidence >= 60 ? trend15m : 'SKIP';
      return { agent: this.name, vote, confidence, reason: reasons.join(' | ') || 'Insufficient confluence' };

    } catch (err) {
      return this._skip(`Error: ${err.message}`);
    }
  }

  _getTrend(candles) {
    const closes = candles.map(c => c.close);
    const ema9  = EMA.calculate({ period: 9,  values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const price = closes[closes.length - 1];
    const e9 = ema9[ema9.length - 1], e21 = ema21[ema21.length - 1];
    if (e9 > e21 && price > e9) return 'BULLISH';
    if (e9 < e21 && price < e9) return 'BEARISH';
    return 'NEUTRAL';
  }

  _getSignal(candles) {
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const ema9  = EMA.calculate({ period: 9,  values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const rsi    = RSI.calculate({ period: 14, values: closes });
    const macd   = MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes });
    const stoch  = Stochastic.calculate({ period: 14, signalPeriod: 3, high: highs, low: lows, close: closes });
    const bb     = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });
    const price  = closes[closes.length - 1];
    const lastBB = bb[bb.length - 1];
    let bbPosition = 'MIDDLE';
    if (lastBB) {
      if (price <= lastBB.lower * 1.002)      bbPosition = 'LOWER';
      else if (price >= lastBB.upper * 0.998) bbPosition = 'UPPER';
    }
    const e9 = ema9[ema9.length - 1], e21 = ema21[ema21.length - 1];
    let bias = 'NEUTRAL';
    if (e9 > e21 && price > e9) bias = 'BULLISH';
    else if (e9 < e21 && price < e9) bias = 'BEARISH';
    return {
      bias,
      rsi:      rsi[rsi.length - 1] || 50,
      macdHist: macd[macd.length - 1]?.histogram || 0,
      stochK:   stoch[stoch.length - 1]?.k || 50,
      stochD:   stoch[stoch.length - 1]?.d || 50,
      bbPosition,
    };
  }

  _skip(reason) { return { agent: this.name, vote: 'SKIP', confidence: 0, reason }; }
}