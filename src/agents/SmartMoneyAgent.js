// SmartMoneyAgent.js
// Philosophy: Smart Money Concepts (SMC) — price action only
// Uses: CHoCH (Change of Character), BOS (Break of Structure),
//       Liquidity sweeps, Fair Value Gaps (FVG), Pin bars, Order blocks
// Zero lagging indicators — pure price structure
// Returns: { vote: 'BUY'|'SELL'|'SKIP', confidence: 0-100, reason: string }

import { ATR } from 'technicalindicators';
import { TwelveDataClient } from '../TwelveDataClient.js';

export class SmartMoneyAgent {
  constructor() {
    this.tdClient = new TwelveDataClient();
    this.name = 'SmartMoneyAgent';
  }

  async analyze(pair) {
    try {
      const candles1H = await this._fetch(pair, '1h',   60); await this._sleep(500);
      const candles5m = await this._fetch(pair, '5min', 80);

      if (!candles1H || !candles5m) {
        return this._skip('Failed to fetch candles');
      }

      // 1H structure: establish market bias via BOS/CHoCH
      const structure1H = this._getMarketStructure(candles1H);
      if (structure1H.bias === 'NEUTRAL') {
        return this._skip('1H structure is neutral — no clear SMC bias');
      }

      let score = 0;
      const reasons = [];
      const direction = structure1H.bias;

      // 1. Market Structure (BOS / CHoCH) on 1H
      if (structure1H.bos) {
        score += 30; reasons.push(`1H BOS confirmed — ${direction} structure`);
      } else if (structure1H.choch) {
        score += 20; reasons.push(`1H CHoCH — structure shift to ${direction}`);
      }

      // 2. Liquidity sweep on 5m (stop hunt before real move)
      const sweep = this._detectLiquiditySweep(candles5m, direction);
      if (sweep.detected) {
        score += 25; reasons.push(`Liquidity sweep: ${sweep.description}`);
      }

      // 3. Fair Value Gap (FVG/Imbalance) on 5m
      const fvg = this._detectFVG(candles5m, direction);
      if (fvg.detected) {
        score += 20; reasons.push(`FVG detected: ${fvg.description}`);
      }

      // 4. Pin bar / rejection candle on 5m (entry trigger)
      const pinBar = this._detectPinBar(candles5m, direction);
      if (pinBar.detected) {
        score += 15; reasons.push(`Pin bar: ${pinBar.description}`);
      }

      // 5. Order block on 1H (institutional entry zone)
      const orderBlock = this._detectOrderBlock(candles1H, direction);
      if (orderBlock.detected) {
        score += 10; reasons.push(`Order block: ${orderBlock.description}`);
      }

      // Penalty: price in middle of range with no confluence
      if (score < 25) {
        return this._skip('Insufficient SMC confluence — no clean setup');
      }

      const confidence = Math.min(100, score);
      const vote = confidence >= 55 ? direction : 'SKIP';

      return {
        agent: this.name,
        vote,
        confidence,
        reason: reasons.join(' | '),
        details: {
          structure1H: structure1H.bias,
          bos: structure1H.bos,
          choch: structure1H.choch,
          sweep: sweep.detected,
          fvg: fvg.detected,
          pinBar: pinBar.detected,
        }
      };

    } catch (err) {
      return this._skip(`Error: ${err.message}`);
    }
  }

  // ── Market Structure: BOS and CHoCH detection ────────────────
  // BOS (Break of Structure): price breaks a significant swing high/low
  // CHoCH (Change of Character): first break opposite to recent trend
  _getMarketStructure(candles) {
    const len = candles.length;
    if (len < 20) return { bias: 'NEUTRAL', bos: false, choch: false };

    // Find recent swing highs and lows (last 20 candles)
    const recent = candles.slice(-20);
    const swingHighs = [];
    const swingLows  = [];

    for (let i = 2; i < recent.length - 2; i++) {
      const c = recent[i];
      // Swing high: higher than 2 candles on each side
      if (c.high > recent[i-1].high && c.high > recent[i-2].high &&
          c.high > recent[i+1].high && c.high > recent[i+2].high) {
        swingHighs.push({ index: i, price: c.high });
      }
      // Swing low: lower than 2 candles on each side
      if (c.low < recent[i-1].low && c.low < recent[i-2].low &&
          c.low < recent[i+1].low && c.low < recent[i+2].low) {
        swingLows.push({ index: i, price: c.low });
      }
    }

    const lastCandle = candles[len - 1];
    const lastClose  = lastCandle.close;

    // BOS bullish: price closes above the most recent swing high
    const lastSwingHigh = swingHighs[swingHighs.length - 1];
    const lastSwingLow  = swingLows[swingLows.length - 1];

    let bos = false, choch = false, bias = 'NEUTRAL';

    if (lastSwingHigh && lastClose > lastSwingHigh.price) {
      bos = true; bias = 'BULLISH';
    } else if (lastSwingLow && lastClose < lastSwingLow.price) {
      bos = true; bias = 'BEARISH';
    }

    // CHoCH: check if this is a character change (look at prior structure)
    if (swingHighs.length >= 2 && swingLows.length >= 2) {
      const prevHigh = swingHighs[swingHighs.length - 2];
      const prevLow  = swingLows[swingLows.length - 2];

      // Was making lower highs (bearish) but just broke a high = bullish CHoCH
      if (lastSwingHigh && prevHigh && lastSwingHigh.price < prevHigh.price && lastClose > lastSwingHigh.price) {
        choch = true; bias = 'BULLISH';
      }
      // Was making higher lows (bullish) but just broke a low = bearish CHoCH
      if (lastSwingLow && prevLow && lastSwingLow.price > prevLow.price && lastClose < lastSwingLow.price) {
        choch = true; bias = 'BEARISH';
      }
    }

    return { bias, bos, choch };
  }

  // ── Liquidity Sweep Detection ─────────────────────────────────
  // Smart money takes out stop losses (sweeps liquidity) before reversing
  // Bullish sweep: wick below a swing low then closes back above it
  // Bearish sweep: wick above a swing high then closes back below it
  _detectLiquiditySweep(candles, direction) {
    const len = candles.length;
    if (len < 10) return { detected: false };

    const recent = candles.slice(-10);
    const last = recent[recent.length - 1];
    const prev = recent[recent.length - 2];

    // Find recent swing low/high in prior 8 candles
    const priorCandles = recent.slice(0, 8);
    const swingLow  = Math.min(...priorCandles.map(c => c.low));
    const swingHigh = Math.max(...priorCandles.map(c => c.high));

    if (direction === 'BULLISH') {
      // Bullish sweep: last candle wick went below swing low but closed above it
      const sweptLow = last.low < swingLow && last.close > swingLow;
      // Or prior candle swept and current is recovering
      const prevSwept = prev.low < swingLow && last.close > prev.close;
      if (sweptLow || prevSwept) {
        return { detected: true, description: `Swept lows at ${swingLow.toFixed(2)}, recovery forming` };
      }
    } else {
      // Bearish sweep: wick above swing high but closed below it
      const sweptHigh = last.high > swingHigh && last.close < swingHigh;
      const prevSwept = prev.high > swingHigh && last.close < prev.close;
      if (sweptHigh || prevSwept) {
        return { detected: true, description: `Swept highs at ${swingHigh.toFixed(2)}, rejection forming` };
      }
    }

    return { detected: false };
  }

  // ── Fair Value Gap (FVG) Detection ───────────────────────────
  // FVG: a 3-candle imbalance where candle 3's low > candle 1's high (bullish)
  // or candle 3's high < candle 1's low (bearish)
  // Price returning to fill FVG = high probability entry
  _detectFVG(candles, direction) {
    const len = candles.length;
    if (len < 5) return { detected: false };

    const last   = candles[len - 1];
    const price  = last.close;

    // Check last 15 candles for FVG zones
    for (let i = 2; i < Math.min(15, len); i++) {
      const c1 = candles[len - 1 - i];
      const c2 = candles[len - 2 - i]; // middle candle (ignored)
      const c3 = candles[len - 3 - i];
      if (!c1 || !c3) continue;

      if (direction === 'BULLISH') {
        // Bullish FVG: c3.low > c1.high (gap between c1 top and c3 bottom)
        if (c3.low > c1.high) {
          const fvgMid = (c3.low + c1.high) / 2;
          // Price is currently in or near the FVG zone
          if (price >= c1.high && price <= c3.low * 1.01) {
            return { detected: true, description: `Bullish FVG zone ${c1.high.toFixed(2)}-${c3.low.toFixed(2)}, price filling` };
          }
        }
      } else {
        // Bearish FVG: c3.high < c1.low
        if (c3.high < c1.low) {
          if (price <= c1.low && price >= c3.high * 0.99) {
            return { detected: true, description: `Bearish FVG zone ${c3.high.toFixed(2)}-${c1.low.toFixed(2)}, price filling` };
          }
        }
      }
    }

    return { detected: false };
  }

  // ── Pin Bar / Rejection Candle ────────────────────────────────
  // Long wick showing price rejection — entry trigger for SMC
  _detectPinBar(candles, direction) {
    const len = candles.length;
    if (len < 3) return { detected: false };

    const last = candles[len - 1];
    const prev = candles[len - 2];

    const body     = Math.abs(last.close - last.open);
    const range    = last.high - last.low;
    const lowWick  = Math.min(last.open, last.close) - last.low;
    const highWick = last.high - Math.max(last.open, last.close);

    if (range === 0) return { detected: false };
    const bodyRatio = body / range;

    if (direction === 'BULLISH') {
      // Bullish pin: small body, long lower wick (rejection of lows)
      if (bodyRatio < 0.4 && lowWick >= body * 2) {
        return { detected: true, description: `Bullish pin bar — lower wick ${(lowWick/range*100).toFixed(0)}% of range` };
      }
      // Bullish engulfing
      if (last.close > last.open && last.close > prev.open && last.open < prev.close) {
        return { detected: true, description: 'Bullish engulfing candle' };
      }
    } else {
      // Bearish pin: small body, long upper wick
      if (bodyRatio < 0.4 && highWick >= body * 2) {
        return { detected: true, description: `Bearish pin bar — upper wick ${(highWick/range*100).toFixed(0)}% of range` };
      }
      // Bearish engulfing
      if (last.close < last.open && last.close < prev.open && last.open > prev.close) {
        return { detected: true, description: 'Bearish engulfing candle' };
      }
    }

    return { detected: false };
  }

  // ── Order Block Detection ─────────────────────────────────────
  // Order block: last bearish candle before bullish impulse (or vice versa)
  // Price returning to this zone = institutional re-entry
  _detectOrderBlock(candles, direction) {
    const len = candles.length;
    if (len < 10) return { detected: false };

    const currentPrice = candles[len - 1].close;

    // Look for the last opposing candle before the most recent strong impulse
    for (let i = 3; i < 15 && i < len; i++) {
      const c = candles[len - 1 - i];
      const next = candles[len - i];     // candle after potential OB
      const next2 = candles[len - i + 1]; // one more after

      if (!c || !next || !next2) continue;

      if (direction === 'BULLISH') {
        // Bearish candle (OB) followed by strong bullish move
        const isOB = c.close < c.open; // red candle
        const strongMove = next.close > c.high && next2.close > next.close;
        if (isOB && strongMove) {
          // Price returning to OB zone (between c.low and c.high)
          if (currentPrice >= c.low && currentPrice <= c.high * 1.005) {
            return { detected: true, description: `Bullish OB zone ${c.low.toFixed(2)}-${c.high.toFixed(2)}` };
          }
        }
      } else {
        // Bullish candle (OB) followed by strong bearish move
        const isOB = c.close > c.open; // green candle
        const strongMove = next.close < c.low && next2.close < next.close;
        if (isOB && strongMove) {
          if (currentPrice <= c.high && currentPrice >= c.low * 0.995) {
            return { detected: true, description: `Bearish OB zone ${c.low.toFixed(2)}-${c.high.toFixed(2)}` };
          }
        }
      }
    }

    return { detected: false };
  }

  _skip(reason) {
    return { agent: this.name, vote: 'SKIP', confidence: 0, reason, details: {} };
  }

  async _fetch(pair, interval, size) {
    return this.tdClient.fetchCandles(pair, interval, size);
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
