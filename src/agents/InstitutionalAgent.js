// InstitutionalAgent.js
// Philosophy: Institutional / macro trend following
// Uses: ADX (trend strength), EMA alignment on 1H + 4H, volume momentum
// Only fires on STRONG trending markets — ignores choppy/ranging conditions
// No scalp signals — intraday only, high conviction
// Returns: { vote: 'BUY'|'SELL'|'SKIP', confidence: 0-100, reason: string }

import { EMA, ADX, ATR, RSI } from 'technicalindicators';
import { TwelveDataClient } from '../TwelveDataClient.js';

export class InstitutionalAgent {
  constructor() {
    this.tdClient = new TwelveDataClient();
    this.name = 'InstitutionalAgent';
  }

  async analyze(pair) {
    try {
      const candles4H = await this._fetch(pair, '4h', 60); await this._sleep(500);
      const candles1H = await this._fetch(pair, '1h', 100);

      if (!candles4H || !candles1H) {
        return this._skip('Failed to fetch candles');
      }

      // 4H macro: must have clear directional bias
      const macro4H = this._getMacro(candles4H);
      if (macro4H.trend === 'NEUTRAL') {
        return this._skip('4H macro is neutral — no institutional bias');
      }

      // 1H trend: must align with 4H
      const macro1H = this._getMacro(candles1H);
      if (macro1H.trend === 'NEUTRAL') {
        return this._skip('1H trend is neutral');
      }

      if (macro4H.trend !== macro1H.trend) {
        return this._skip(`Timeframe conflict: 4H=${macro4H.trend} vs 1H=${macro1H.trend}`);
      }

      const direction = macro4H.trend;
      let score = 0;
      const reasons = [];

      // ADX strength on 4H — core filter
      // Institutions don't trade without a clear trend
      if (macro4H.adx > 40) {
        score += 35; reasons.push(`4H ADX ${macro4H.adx.toFixed(0)} — very strong trend`);
      } else if (macro4H.adx > 30) {
        score += 25; reasons.push(`4H ADX ${macro4H.adx.toFixed(0)} — strong trend`);
      } else if (macro4H.adx > 20) {
        score += 10; reasons.push(`4H ADX ${macro4H.adx.toFixed(0)} — moderate trend`);
      } else {
        return this._skip(`4H ADX ${macro4H.adx.toFixed(0)} too weak — ranging market`);
      }

      // ADX strength on 1H
      if (macro1H.adx > 30) {
        score += 25; reasons.push(`1H ADX ${macro1H.adx.toFixed(0)} confirms strength`);
      } else if (macro1H.adx > 20) {
        score += 15; reasons.push(`1H ADX ${macro1H.adx.toFixed(0)} moderate`);
      }

      // EMA50 vs EMA21 separation on 4H (trend conviction)
      const emaSeparation4H = Math.abs(macro4H.ema21 - macro4H.ema50) / macro4H.ema50 * 100;
      if (emaSeparation4H > 0.5) {
        score += 20; reasons.push(`4H EMA separation ${emaSeparation4H.toFixed(2)}% — strong momentum`);
      } else if (emaSeparation4H > 0.2) {
        score += 10; reasons.push(`4H EMA separation ${emaSeparation4H.toFixed(2)}%`);
      }

      // Price position relative to EMA50 on 1H
      // Institutions enter on pullbacks to EMA50, not chasing
      const priceDist1H = (macro1H.price - macro1H.ema50) / macro1H.ema50 * 100;
      if (direction === 'BULLISH') {
        if (priceDist1H > 0 && priceDist1H < 1.5) {
          score += 20; reasons.push(`Price ${priceDist1H.toFixed(2)}% above EMA50 — clean pullback zone`);
        } else if (priceDist1H > 1.5) {
          score -= 10; reasons.push(`Price ${priceDist1H.toFixed(2)}% above EMA50 — extended, risk of pullback`);
        }
      } else {
        const absDist = Math.abs(priceDist1H);
        if (priceDist1H < 0 && absDist < 1.5) {
          score += 20; reasons.push(`Price ${absDist.toFixed(2)}% below EMA50 — pullback zone`);
        } else if (absDist > 1.5) {
          score -= 10; reasons.push(`Price ${absDist.toFixed(2)}% below EMA50 — extended`);
        }
      }

      const confidence = Math.max(0, Math.min(100, score));
      const vote = confidence >= 65 ? direction : 'SKIP';

      return {
        agent: this.name,
        vote,
        confidence,
        reason: reasons.join(' | ') || 'Weak institutional setup',
        details: {
          trend4H: macro4H.trend,
          trend1H: macro1H.trend,
          adx4H: macro4H.adx,
          adx1H: macro1H.adx,
          emaSep: emaSeparation4H,
        }
      };

    } catch (err) {
      return this._skip(`Error: ${err.message}`);
    }
  }

  _getMacro(candles) {
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);

    const ema21 = EMA.calculate({ period: 21, values: closes });
    const ema50 = EMA.calculate({ period: 50, values: closes });
    const adxVals = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

    const lastEma21 = ema21[ema21.length - 1];
    const lastEma50 = ema50[ema50.length - 1];
    const lastPrice = closes[closes.length - 1];
    const lastAdx   = adxVals[adxVals.length - 1]?.adx || 0;

    let trend = 'NEUTRAL';
    if (lastAdx >= 20) {
      if (lastEma21 > lastEma50 && lastPrice > lastEma21) trend = 'BULLISH';
      else if (lastEma21 < lastEma50 && lastPrice < lastEma21) trend = 'BEARISH';
    }

    return { trend, adx: lastAdx, ema21: lastEma21, ema50: lastEma50, price: lastPrice };
  }

  _skip(reason) {
    return { agent: this.name, vote: 'SKIP', confidence: 0, reason, details: {} };
  }

  async _fetch(pair, interval, size) {
    return this.tdClient.fetchCandles(pair, interval, size);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
