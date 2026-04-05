// voting_index.js — Refactored: fetch once, share across all agents

import 'dotenv/config';
import { RetailAgent }           from './agents/RetailAgent.js';
import { InstitutionalAgent }    from './agents/InstitutionalAgent.js';
import { SmartMoneyAgent }       from './agents/SmartMoneyAgent.js';
import { VotingEngine }          from './VotingEngine.js';
import { VotingDiscordNotifier } from './VotingDiscordNotifier.js';
import { SessionManager }        from './SessionManager.js';
import { NewsCache }             from './NewsCache.js';
import { TradeMonitor }          from './TradeMonitor.js';
import { TwelveDataClient }      from './TwelveDataClient.js';
import http                      from 'http';

const PAIRS = ['XAU/USD', 'BTC/USD'];
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const DEBUG = process.env.DEBUG_MODE === 'true';

const retail        = new RetailAgent();
const institutional = new InstitutionalAgent();
const smartMoney    = new SmartMoneyAgent();
const votingEngine  = new VotingEngine();
const notifier      = new VotingDiscordNotifier();
const session       = new SessionManager();
const news          = new NewsCache();
const monitor       = new TradeMonitor();
const tdClient      = new TwelveDataClient();

let stats = { cycles: 0, signals: 0, strongSignals: 0, noConsensus: 0, startTime: Date.now() };

// Fetch all timeframes once — 5 calls x 600ms = ~3s, ~5 credits (under 8/min)
async function fetchAllCandles(pair) {
  const get = async (interval, size) => { await sleep(600); return tdClient.fetchCandles(pair, interval, size); };
  const candles4H  = await get('4h',    60);
  const candles1H  = await get('1h',   100);
  const candles15m = await get('15min', 100);
  const candles5m  = await get('5min',  100);
  const candles1m  = await get('1min',   50);
  if (!candles4H || !candles1H || !candles15m || !candles5m || !candles1m) throw new Error('Null candles returned');
  return { candles4H, candles1H, candles15m, candles5m, candles1m };
}

async function runCycle() {
  stats.cycles++;
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[${new Date().toISOString()}] 🗳️  Voting Cycle #${stats.cycles}`);

  if (monitor.openTrades.size > 0) { console.log(`🔍 Checking ${monitor.openTrades.size} open trades...`); await monitor.checkAll(); }

  await news.refresh();
  const currentSession = session.getSession();
  console.log(`📰 News: ${news.getBias()} | 🕐 ${currentSession.emoji} ${currentSession.name}`);

  let pairCount = 0;

  for (const pair of PAIRS) {
    const isCrypto = pair === 'BTC/USD';
    if (!isCrypto && !session.shouldAnalyze(pair)) { if (DEBUG) console.log(`⏸️  ${pair} — off-hours`); continue; }
    if (pair === 'XAU/USD' && currentSession.name === 'London') { console.log(`⛔ XAU/USD — London blocked`); continue; }

    if (pairCount > 0) { console.log(`\n⏳ Rate limit pause (65s) before ${pair}...`); await sleep(65000); }

    console.log(`\n🔍 ${pair} — fetching candles...`);

    try {
      // ONE fetch shared across all 3 agents — no extra API calls
      const candles = await fetchAllCandles(pair);
      pairCount++;
      console.log(`   Candles ready. Running agents...`);

      // Agents are now synchronous — no await, no extra fetches
      const votes = [
        retail.analyze(pair, candles),
        institutional.analyze(pair, candles),
        smartMoney.analyze(pair, candles),
      ];

      for (const v of votes) {
        const e = v.vote === 'BUY' ? '🟢' : v.vote === 'SELL' ? '🔴' : '⚪';
        console.log(`  ${e} ${v.agent}: ${v.vote} [${v.confidence}%] — ${v.reason}`);
      }

      // VotingEngine uses already-fetched 5m candles — 1 more API call for ATR/price
      const signal = await votingEngine.buildSignal(pair, votes, candles.candles5m, currentSession.boost);

      if (signal) {
        const tag = signal.isStrong ? '🔥 STRONG (3/3)' : '✅ (2/3)';
        console.log(`\n  ✅ CONSENSUS: ${pair} ${signal.action} ${tag}`);
        console.log(`     Entry: ${signal.entry.toFixed(2)} | SL: ${signal.sl.toFixed(2)} | TP: ${signal.tp.toFixed(2)}`);
        stats.signals++;
        if (signal.isStrong) stats.strongSignals++;
        monitor.addTrade(signal);
        await notifier.sendSignal(signal);
      } else {
        stats.noConsensus++;
        console.log(`  ⚪ No consensus — skipped`);
        if (DEBUG) await notifier.sendNoConsensus(pair, votes);
      }

    } catch (err) {
      console.error(`❌ ${pair} error: ${err.message}`);
      pairCount++;
    }
  }

  const uptime = Math.round((Date.now() - stats.startTime) / 1000 / 60);
  console.log(`\n📊 Signals: ${stats.signals} (${stats.strongSignals} strong) | No consensus: ${stats.noConsensus} | Uptime: ${uptime}min`);
}

function startHealthServer() {
  const PORT = process.env.PORT || 3001;
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running', agent: 'voting', cycles: stats.cycles,
      signals: stats.signals, strongSignals: stats.strongSignals,
      noConsensus: stats.noConsensus, openTrades: monitor.openTrades.size,
      uptime: `${Math.round((Date.now() - stats.startTime) / 60000)} minutes`,
      pairs: PAIRS, session: session.getSession().name,
    }));
  }).listen(PORT, () => console.log(`🌐 Health check on port ${PORT}`));
}

async function start() {
  console.log('🗳️  Voting Signal Agent starting...');
  console.log(`📋 Pairs: ${PAIRS.join(', ')}`);
  console.log(`🤖 Agents: RetailAgent | InstitutionalAgent | SmartMoneyAgent`);
  console.log(`⚖️  Consensus: 2/3 to fire | 3/3 = STRONG`);
  console.log(`💡 Candles fetched once per pair — shared across all agents`);

  if (!process.env.DISCORD_VOTING_WEBHOOK) { console.error('❌ FATAL: DISCORD_VOTING_WEBHOOK missing'); process.exit(1); }
  const hasKey = [1,2,3,4,5,6,7,8].some(i => process.env[`TWELVEDATA_API_KEY_${i}`]) || !!process.env.TWELVEDATA_API_KEY_MASTER;
  if (!hasKey) { console.error('❌ FATAL: No TwelveData API keys'); process.exit(1); }

  startHealthServer();
  await runCycle();
  setInterval(runCycle, POLL_INTERVAL_MS);
}

process.on('unhandledRejection', r => console.error('⚠️ Unhandled:', r));
process.on('uncaughtException',  e => console.error('⚠️ Uncaught:', e.message));
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
start();