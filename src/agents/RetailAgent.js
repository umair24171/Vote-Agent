// RetailAgent.js
// Philosophy: Classic retail technical analysis
// Uses: RSI, MACD, Stochastic, Bollinger Bands, EMA crossovers
// Timeframes: 5min signal + 15min confirmation
// Returns: { vote: 'BUY'|'SELL'|'SKIP', confidence: 0-100, reason: string }

import { EMA, RSI, MACD, Stochastic, BollingerBands, ATR } from 'technicalindicators';
import { TwelveDataClient } from '../TwelveDataClient.js';

export class RetailAgent {
  constructor() {
    this.tdClient = new TwelveDataClient();
    this.name = 'RetailAgent';
  }

  async analyze(pair) {
    try {
      const candles15m = await this._fetch(pair, '15min', 100); await this._sleep(500);
      const candles5m  = await this._fetch(pair, '5min',  100);

      if (!candles15m || !candles5m) {
        return this._skip('Failed to fetch candles');
      }

      // 15min trend confirmation
      const trend15m = this._getTrend(candles15m);
      if (trend15m === 'NEUTRAL') {
        return this._skip('15m trend is neutral — no edge');
      }

      // 5min signal
      const signal = this._getSignal(candles5m);

      // Both timeframes must agree
      if (trend15m !== signal.bias) {
        return this._skip(`MTF conflict: 15m=${trend15m} vs 5m=${signal.bias}`);
      }

      // Score the setup
      let score = 0;
      const reasons = [];

      // RSI confirmation
      if (trend15m === 'BULLISH') {
        if (signal.rsi > 40 && signal.rsi < 65) { score += 25; reasons.push(`RSI ${signal.rsi.toFixed(0)} bullish zone`); }
        else if (signal.rsi <= 40) { score += 5; reasons.push(`RSI oversold ${signal.rsi.toFixed(0)}`); }
      } else {
        if (signal.rsi > 35 && signal.rsi < 60) { score += 25; reasons.push(`RSI ${signal.rsi.toFixed(0)} bearish zone`); }
        else if (signal.rsi >= 60) { score += 5; reasons.push(`RSI overbought ${signal.rsi.toFixed(0)}`); }
      }

      // MACD histogram
      if (trend15m === 'BULLISH' && signal.macdHist > 0) {
        score += 25; reasons.push('MACD hist positive');
      } else if (trend15m === 'BEARISH' && signal.macdHist < 0) {
        score += 25; reasons.push('MACD hist negative');
      }

      // Stochastic
      if (trend15m === 'BULLISH' && signal.stochK > signal.stochD && signal.stochK < 80) {
        score += 20; reasons.push(`Stoch K>${signal.stochK.toFixed(0)} crossing up`);
      } else if (trend15m === 'BEARISH' && signal.stochK < signal.stochD && signal.stochK > 20) {
        score += 20; reasons.push(`Stoch K<${signal.stochK.toFixed(0)} crossing down`);
      }

      // Bollinger Bands
      if (trend15m === 'BULLISH' && signal.bbPosition === 'LOWER') {
        score += 15; reasons.push('Price at BB lower — bounce zone');
      } else if (trend15m === 'BEARISH' && signal.bbPosition === 'UPPER') {
        score += 15; reasons.push('Price at BB upper — rejection zone');
      } else if (signal.bbPosition === 'MIDDLE') {
        score += 8; reasons.push('Price mid BB');
      }

      // EMA alignment (5m)
      if (trend15m === signal.bias) {
        score += 15; reasons.push('EMA9 > EMA21 aligned with trend');
      }

      const confidence = Math.min(100, score);
      const vote = confidence >= 60 ? trend15m : 'SKIP';

      return {
        agent: this.name,
        vote,
        confidence,
        reason: reasons.join(' | ') || 'Insufficient confluence',
        details: { trend15m, rsi: signal.rsi, macdHist: signal.macdHist, stochK: signal.stochK, bbPosition: signal.bbPosition }
      };

    } catch (err) {
      return this._skip(`Error: ${err.message}`);
    }
  }

  _getTrend(candles) {
    const closes = candles.map(c => c.close);
    const ema9  = EMA.calculate({ period: 9,  values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const price = closes[closes.length - 1];
    const lastEma9  = ema9[ema9.length - 1];
    const lastEma21 = ema21[ema21.length - 1];

    if (lastEma9 > lastEma21 && price > lastEma9) return 'BULLISH';
    if (lastEma9 < lastEma21 && price < lastEma9) return 'BEARISH';
    return 'NEUTRAL';
  }

  _getSignal(candles) {
    const closes = candles.map(c => c.close);
    const highs  = candles.map(c => c.high);
    const lows   = candles.map(c => c.low);

    const ema9  = EMA.calculate({ period: 9,  values: closes });
    const ema21 = EMA.calculate({ period: 21, values: closes });
    const rsiVals   = RSI.calculate({ period: 14, values: closes });
    const macdVals  = MACD.calculate({ fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, values: closes });
    const stochVals = Stochastic.calculate({ period: 14, signalPeriod: 3, high: highs, low: lows, close: closes });
    const bbVals    = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });

    const price = closes[closes.length - 1];
    const lastBB = bbVals[bbVals.length - 1];
    let bbPosition = 'MIDDLE';
    if (lastBB) {
      if (price <= lastBB.lower * 1.002)      bbPosition = 'LOWER';
      else if (price >= lastBB.upper * 0.998) bbPosition = 'UPPER';
    }

    const lastEma9  = ema9[ema9.length - 1];
    const lastEma21 = ema21[ema21.length - 1];
    let bias = 'NEUTRAL';
    if (lastEma9 > lastEma21 && price > lastEma9)      bias = 'BULLISH';
    else if (lastEma9 < lastEma21 && price < lastEma9) bias = 'BEARISH';

    return {
      bias,
      rsi:      rsiVals[rsiVals.length - 1] || 50,
      macdHist: macdVals[macdVals.length - 1]?.histogram || 0,
      stochK:   stochVals[stochVals.length - 1]?.k || 50,
      stochD:   stochVals[stochVals.length - 1]?.d || 50,
      bbPosition,
    };
  }

  _skip(reason) {
    return { agent: this.name, vote: 'SKIP', confidence: 0, reason, details: {} };
  }

  async _fetch(pair, interval, size) {
    return this.tdClient.fetchCandles(pair, interval, size);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
