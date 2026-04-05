// SmartMoneyAgent.js — Synchronous: receives pre-fetched candles, no API calls
// Philosophy: SMC — CHoCH, BOS, liquidity sweeps, FVG, pin bars, order blocks

import { ATR } from 'technicalindicators';

export class SmartMoneyAgent {
  constructor() { this.name = 'SmartMoneyAgent'; }

  analyze(pair, candles) {
    try {
      const structure1H = this._getMarketStructure(candles.candles1H);
      if (structure1H.bias === 'NEUTRAL') return this._skip('1H structure neutral — no SMC bias');

      const direction = structure1H.bias;
      let score = 0;
      const reasons = [];

      // 1. BOS / CHoCH on 1H
      if (structure1H.bos)   { score += 30; reasons.push(`1H BOS confirmed — ${direction}`); }
      else if (structure1H.choch) { score += 20; reasons.push(`1H CHoCH — structure shift to ${direction}`); }

      // 2. Liquidity sweep on 5m
      const sweep = this._detectLiquiditySweep(candles.candles5m, direction);
      if (sweep.detected) { score += 25; reasons.push(`Sweep: ${sweep.description}`); }

      // 3. FVG on 5m
      const fvg = this._detectFVG(candles.candles5m, direction);
      if (fvg.detected) { score += 20; reasons.push(`FVG: ${fvg.description}`); }

      // 4. Pin bar on 5m
      const pinBar = this._detectPinBar(candles.candles5m, direction);
      if (pinBar.detected) { score += 15; reasons.push(`${pinBar.description}`); }

      // 5. Order block on 1H
      const ob = this._detectOrderBlock(candles.candles1H, direction);
      if (ob.detected) { score += 10; reasons.push(`OB: ${ob.description}`); }

      if (score < 25) return this._skip('Insufficient SMC confluence');

      const confidence = Math.min(100, score);
      const vote = confidence >= 55 ? direction : 'SKIP';
      return { agent: this.name, vote, confidence, reason: reasons.join(' | ') };

    } catch (err) {
      return this._skip(`Error: ${err.message}`);
    }
  }

  _getMarketStructure(candles) {
    const len = candles.length;
    if (len < 20) return { bias: 'NEUTRAL', bos: false, choch: false };
    const recent = candles.slice(-20);
    const swingHighs = [], swingLows = [];
    for (let i = 2; i < recent.length - 2; i++) {
      const c = recent[i];
      if (c.high > recent[i-1].high && c.high > recent[i-2].high && c.high > recent[i+1].high && c.high > recent[i+2].high)
        swingHighs.push({ index: i, price: c.high });
      if (c.low < recent[i-1].low && c.low < recent[i-2].low && c.low < recent[i+1].low && c.low < recent[i+2].low)
        swingLows.push({ index: i, price: c.low });
    }
    const lastClose = candles[len - 1].close;
    const lastHigh  = swingHighs[swingHighs.length - 1];
    const lastLow   = swingLows[swingLows.length - 1];
    let bos = false, choch = false, bias = 'NEUTRAL';
    if (lastHigh && lastClose > lastHigh.price) { bos = true; bias = 'BULLISH'; }
    else if (lastLow && lastClose < lastLow.price) { bos = true; bias = 'BEARISH'; }
    if (swingHighs.length >= 2 && swingLows.length >= 2) {
      const prevHigh = swingHighs[swingHighs.length - 2];
      const prevLow  = swingLows[swingLows.length - 2];
      if (lastHigh && prevHigh && lastHigh.price < prevHigh.price && lastClose > lastHigh.price) { choch = true; bias = 'BULLISH'; }
      if (lastLow  && prevLow  && lastLow.price  > prevLow.price  && lastClose < lastLow.price)  { choch = true; bias = 'BEARISH'; }
    }
    return { bias, bos, choch };
  }

  _detectLiquiditySweep(candles, direction) {
    const len = candles.length;
    if (len < 10) return { detected: false };
    const recent = candles.slice(-10);
    const last = recent[recent.length - 1];
    const prev = recent[recent.length - 2];
    const prior = recent.slice(0, 8);
    const swingLow  = Math.min(...prior.map(c => c.low));
    const swingHigh = Math.max(...prior.map(c => c.high));
    if (direction === 'BULLISH') {
      if ((last.low < swingLow && last.close > swingLow) || (prev.low < swingLow && last.close > prev.close))
        return { detected: true, description: `Swept lows at ${swingLow.toFixed(2)}` };
    } else {
      if ((last.high > swingHigh && last.close < swingHigh) || (prev.high > swingHigh && last.close < prev.close))
        return { detected: true, description: `Swept highs at ${swingHigh.toFixed(2)}` };
    }
    return { detected: false };
  }

  _detectFVG(candles, direction) {
    const len = candles.length;
    if (len < 5) return { detected: false };
    const price = candles[len - 1].close;
    for (let i = 2; i < Math.min(15, len); i++) {
      const c1 = candles[len - 1 - i];
      const c3 = candles[len - 3 - i];
      if (!c1 || !c3) continue;
      if (direction === 'BULLISH' && c3.low > c1.high && price >= c1.high && price <= c3.low * 1.01)
        return { detected: true, description: `Bullish FVG ${c1.high.toFixed(2)}-${c3.low.toFixed(2)}` };
      if (direction === 'BEARISH' && c3.high < c1.low && price <= c1.low && price >= c3.high * 0.99)
        return { detected: true, description: `Bearish FVG ${c3.high.toFixed(2)}-${c1.low.toFixed(2)}` };
    }
    return { detected: false };
  }

  _detectPinBar(candles, direction) {
    const len = candles.length;
    if (len < 3) return { detected: false };
    const last = candles[len - 1];
    const prev = candles[len - 2];
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    if (range === 0) return { detected: false };
    const lowWick  = Math.min(last.open, last.close) - last.low;
    const highWick = last.high - Math.max(last.open, last.close);
    const bodyRatio = body / range;
    if (direction === 'BULLISH') {
      if (bodyRatio < 0.4 && lowWick >= body * 2)
        return { detected: true, description: `Bullish pin bar — lower wick ${(lowWick/range*100).toFixed(0)}%` };
      if (last.close > last.open && last.close > prev.open && last.open < prev.close)
        return { detected: true, description: 'Bullish engulfing' };
    } else {
      if (bodyRatio < 0.4 && highWick >= body * 2)
        return { detected: true, description: `Bearish pin bar — upper wick ${(highWick/range*100).toFixed(0)}%` };
      if (last.close < last.open && last.close < prev.open && last.open > prev.close)
        return { detected: true, description: 'Bearish engulfing' };
    }
    return { detected: false };
  }

  _detectOrderBlock(candles, direction) {
    const len = candles.length;
    if (len < 10) return { detected: false };
    const price = candles[len - 1].close;
    for (let i = 3; i < 15 && i < len; i++) {
      const c = candles[len - 1 - i];
      const next = candles[len - i];
      const next2 = candles[len - i + 1];
      if (!c || !next || !next2) continue;
      if (direction === 'BULLISH') {
        if (c.close < c.open && next.close > c.high && next2.close > next.close && price >= c.low && price <= c.high * 1.005)
          return { detected: true, description: `Bullish OB ${c.low.toFixed(2)}-${c.high.toFixed(2)}` };
      } else {
        if (c.close > c.open && next.close < c.low && next2.close < next.close && price <= c.high && price >= c.low * 0.995)
          return { detected: true, description: `Bearish OB ${c.low.toFixed(2)}-${c.high.toFixed(2)}` };
      }
    }
    return { detected: false };
  }

  _skip(reason) { return { agent: this.name, vote: 'SKIP', confidence: 0, reason }; }
}