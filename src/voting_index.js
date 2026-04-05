// voting_index.js
// Voting Signal Agent — Main Entry Point
// Runs 3 independent agents on XAU/USD and BTC/USD
// Fires signal only when 2/3 agents agree on direction
// Posts to separate Discord channel for clean comparison vs Master Agent

import 'dotenv/config';
import { RetailAgent }          from './agents/RetailAgent.js';
import { InstitutionalAgent }   from './agents/InstitutionalAgent.js';
import { SmartMoneyAgent }      from './agents/SmartMoneyAgent.js';
import { VotingEngine }         from './VotingEngine.js';
import { VotingDiscordNotifier }from './VotingDiscordNotifier.js';
import { SessionManager }       from './SessionManager.js';
import { NewsCache }            from './NewsCache.js';
import { TradeMonitor }         from './TradeMonitor.js';
import http                     from 'http';

// ── Pairs: Only our two best performers ──────────────────────────
// XAU: 48.7% WR, BTC: 50.8% WR — the rest weren't worth it
const PAIRS = ['XAU/USD', 'BTC/USD'];

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEBUG = process.env.DEBUG_MODE === 'true';

// ── Instances ────────────────────────────────────────────────────
const retail       = new RetailAgent();
const institutional= new InstitutionalAgent();
const smartMoney   = new SmartMoneyAgent();
const votingEngine = new VotingEngine();
const notifier     = new VotingDiscordNotifier();
const session      = new SessionManager();
const news         = new NewsCache();
const monitor      = new TradeMonitor();

// ── Stats ────────────────────────────────────────────────────────
let stats = {
  cycles:       0,
  signals:      0,
  strongSignals:0,
  noConsensus:  0,
  startTime:    Date.now(),
};

// ── Main Cycle ───────────────────────────────────────────────────
async function runCycle() {
  stats.cycles++;
  const cycleTime = new Date().toISOString();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[${cycleTime}] 🗳️  Voting Cycle #${stats.cycles}`);

  // Check open trades first
  if (monitor.openTrades.size > 0) {
    console.log(`🔍 Checking ${monitor.openTrades.size} open trade(s)...`);
    await monitor.checkAll();
  }

  // Refresh news + session
  await news.refresh();
  const currentSession = session.getSession();
  const newsBias       = news.getBias();

  console.log(`📰 News: ${newsBias}`);
  console.log(`🕐 Session: ${currentSession.emoji} ${currentSession.name}`);

  // Analyze each pair
  for (const pair of PAIRS) {
    const isCrypto = pair === 'BTC/USD';

    // Skip forex during off-hours
    if (!isCrypto && !session.shouldAnalyze(pair)) {
      if (DEBUG) console.log(`⏸️  ${pair} — off-hours`);
      continue;
    }

    // Session guards (from backtest data)
    if (pair === 'XAU/USD' && currentSession.name === 'London') {
      console.log(`⛔ XAU/USD — blocked (London sess, 29.6% WR)`);
      continue;
    }

    console.log(`\n🔍 Analyzing ${pair}...`);

    try {
      // ── Run all 3 agents in parallel ──────────────────────────
      // Each agent fetches its own data independently
      const [retailVote, institutionalVote, smartMoneyVote] = await Promise.all([
        retail.analyze(pair),
        institutional.analyze(pair),
        smartMoney.analyze(pair),
      ]);

      const votes = [retailVote, institutionalVote, smartMoneyVote];

      // Log all votes
      for (const v of votes) {
        const emoji = v.vote === 'BUY' ? '🟢' : v.vote === 'SELL' ? '🔴' : '⚪';
        console.log(`  ${emoji} ${v.agent}: ${v.vote} [${v.confidence}%] — ${v.reason}`);
      }

      // ── Build signal if consensus ──────────────────────────────
      const signal = await votingEngine.buildSignal(pair, votes, currentSession.boost);

      if (signal) {
        const strengthTag = signal.isStrong ? '🔥 STRONG (3/3)' : '✅ (2/3)';
        console.log(`\n  ✅ CONSENSUS: ${pair} ${signal.action} ${strengthTag}`);
        console.log(`     Entry: ${signal.entry.toFixed(2)} | SL: ${signal.sl.toFixed(2)} | TP: ${signal.tp.toFixed(2)}`);

        stats.signals++;
        if (signal.isStrong) stats.strongSignals++;

        monitor.addTrade(signal);
        await notifier.sendSignal(signal);
      } else {
        stats.noConsensus++;
        console.log(`  ⚪ No consensus — signal skipped`);
        if (DEBUG) await notifier.sendNoConsensus(pair, votes);
      }

      // Rate limit pause between pairs
      await sleep(3000);

    } catch (err) {
      console.error(`❌ ${pair} voting error: ${err.message}`);
    }
  }

  // Stats summary
  const uptime = Math.round((Date.now() - stats.startTime) / 1000 / 60);
  console.log(`\n📊 Signals: ${stats.signals} (${stats.strongSignals} strong) | No consensus: ${stats.noConsensus} | Uptime: ${uptime}min`);
}

// ── Health Check Server ──────────────────────────────────────────
function startHealthServer() {
  const PORT = process.env.PORT || 3001;
  http.createServer((req, res) => {
    const uptime = Math.round((Date.now() - stats.startTime) / 1000 / 60);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status:        'running',
      agent:         'voting',
      cycles:        stats.cycles,
      signals:       stats.signals,
      strongSignals: stats.strongSignals,
      noConsensus:   stats.noConsensus,
      openTrades:    monitor.openTrades.size,
      uptime:        `${uptime} minutes`,
      pairs:         PAIRS,
      session:       session.getSession().name,
    }));
  }).listen(PORT, () => {
    console.log(`🌐 Health check on port ${PORT}`);
  });
}

// ── Startup ──────────────────────────────────────────────────────
async function start() {
  console.log('🗳️  Voting Signal Agent starting...');
  console.log(`📋 Pairs: ${PAIRS.join(', ')}`);
  console.log(`🤖 Agents: RetailAgent | InstitutionalAgent | SmartMoneyAgent`);
  console.log(`⚖️  Consensus required: 2/3 (3/3 = STRONG)`);
  console.log(`⏱️  Poll interval: every 5 minutes`);

  if (!process.env.DISCORD_VOTING_WEBHOOK) {
    console.error('❌ FATAL: DISCORD_VOTING_WEBHOOK not set!');
    process.exit(1);
  }

  const hasKey = [1,2,3,4,5,6,7,8].some(i => process.env[`TWELVEDATA_API_KEY_${i}`])
    || !!process.env.TWELVEDATA_API_KEY_MASTER;
  if (!hasKey) {
    console.error('❌ FATAL: No TwelveData API keys found!');
    process.exit(1);
  }

  console.log(`📡 Discord: ✅ connected`);
  console.log('');

  startHealthServer();
  await runCycle();
  setInterval(runCycle, POLL_INTERVAL_MS);
}

process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught exception:', err.message);
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

start();
