// InstitutionalAgent.js — Synchronous: receives pre-fetched candles, no API calls
// Philosophy: Macro trend following — ADX strength, EMA on 4H + 1H only

import { EMA, ADX } from 'technicalindicators';

export class InstitutionalAgent {
  constructor() { this.name = 'InstitutionalAgent'; }

  analyze(pair, candles) {
    try {
      const macro4H = this._getMacro(candles.candles4H);
      if (macro4H.trend === 'NEUTRAL') return this._skip('4H macro neutral — no institutional bias');

      const macro1H = this._getMacro(candles.candles1H);
      if (macro1H.trend === 'NEUTRAL') return this._skip('1H trend neutral');

      if (macro4H.trend !== macro1H.trend) return this._skip(`TF conflict: 4H=${macro4H.trend} vs 1H=${macro1H.trend}`);

      const direction = macro4H.trend;
      let score = 0;
      const reasons = [];

      // ADX on 4H — core filter, institutions don't trade without clear trend
      if (macro4H.adx > 40) { score += 35; reasons.push(`4H ADX ${macro4H.adx.toFixed(0)} — very strong`); }
      else if (macro4H.adx > 30) { score += 25; reasons.push(`4H ADX ${macro4H.adx.toFixed(0)} — strong`); }
      else if (macro4H.adx > 20) { score += 10; reasons.push(`4H ADX ${macro4H.adx.toFixed(0)} — moderate`); }
      else return this._skip(`4H ADX ${macro4H.adx.toFixed(0)} too weak — ranging`);

      // ADX on 1H
      if (macro1H.adx > 30) { score += 25; reasons.push(`1H ADX ${macro1H.adx.toFixed(0)} confirms`); }
      else if (macro1H.adx > 20) { score += 15; reasons.push(`1H ADX ${macro1H.adx.toFixed(0)} moderate`); }

      // EMA50 vs EMA21 separation on 4H (trend conviction)
      const sep = Math.abs(macro4H.ema21 - macro4H.ema50) / macro4H.ema50 * 100;
      if (sep > 0.5) { score += 20; reasons.push(`4H EMA sep ${sep.toFixed(2)}% — strong momentum`); }
      else if (sep > 0.2) { score += 10; reasons.push(`4H EMA sep ${sep.toFixed(2)}%`); }

      // Price vs EMA50 on 1H — institutions enter on pullbacks, not chasing
      const dist = (macro1H.price - macro1H.ema50) / macro1H.ema50 * 100;
      if (direction === 'BULLISH') {
        if (dist > 0 && dist < 1.5) { score += 20; reasons.push(`Price ${dist.toFixed(2)}% above EMA50 — pullback zone`); }
        else if (dist > 1.5) { score -= 10; reasons.push(`Price ${dist.toFixed(2)}% above EMA50 — extended`); }
      } else {
        const absDist = Math.abs(dist);
        if (dist < 0 && absDist < 1.5) { score += 20; reasons.push(`Price ${absDist.toFixed(2)}% below EMA50 — pullback zone`); }
        else if (absDist > 1.5) { score -= 10; reasons.push(`Price ${absDist.toFixed(2)}% below EMA50 — extended`); }
      }

      const confidence = Math.max(0, Math.min(100, score));
      const vote = confidence >= 65 ? direction : 'SKIP';
      return { agent: this.name, vote, confidence, reason: reasons.join(' | ') };

    } catch (err) {
      return this._skip(`Error: ${err.message}`);
    }
  }

  _getMacro(candles) {
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);
    const ema21  = EMA.calculate({ period: 21, values: closes });
    const ema50  = EMA.calculate({ period: 50, values: closes });
    const adxVals = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });
    const e21 = ema21[ema21.length - 1], e50 = ema50[ema50.length - 1];
    const price = closes[closes.length - 1];
    const adx   = adxVals[adxVals.length - 1]?.adx || 0;
    let trend = 'NEUTRAL';
    if (adx >= 20) {
      if (e21 > e50 && price > e21) trend = 'BULLISH';
      else if (e21 < e50 && price < e21) trend = 'BEARISH';
    }
    return { trend, adx, ema21: e21, ema50: e50, price };
  }

  _skip(reason) { return { agent: this.name, vote: 'SKIP', confidence: 0, reason }; }
}