// VotingDiscordNotifier.js
// Sends rich Discord embeds showing all 3 agent votes + consensus result

const WEBHOOK_URL = process.env.DISCORD_VOTING_WEBHOOK;

const COLORS = {
  STRONG_BUY:  0x00E676,  // Bright green — 3/3
  NORMAL_BUY:  0x388E3C,  // Dark green — 2/3
  STRONG_SELL: 0xFF1744,  // Bright red — 3/3
  NORMAL_SELL: 0xC62828,  // Dark red — 2/3
};

const PAIR_EMOJIS = {
  'XAU/USD': '🥇',
  'BTC/USD': '₿',
};

const VOTE_EMOJI = {
  BUY:  '🟢',
  SELL: '🔴',
  SKIP: '⚪',
};

export class VotingDiscordNotifier {

  async sendSignal(signal) {
    try {
      const pairEmoji = PAIR_EMOJIS[signal.pair] || '📊';
      const strength  = signal.isStrong ? '🔥 STRONG' : '✅ CONFIRMED';
      const colorKey  = `${signal.isStrong ? 'STRONG' : 'NORMAL'}_${signal.action}`;
      const color     = COLORS[colorKey] || 0x607D8B;
      const fmt       = (n) => this._formatPrice(signal.pair, n);

      // Build vote breakdown text
      const voteLines = signal.agentResults.map(v => {
        const emoji = VOTE_EMOJI[v.vote] || '⚪';
        const bar   = v.confidence > 0 ? `[${v.confidence}%]` : '';
        return `${emoji} **${v.agent}** ${bar}\n└ ${v.reason}`;
      }).join('\n\n');

      // Consensus summary
      const consensusText = `**${signal.voteCount}/3 agents voted ${signal.action}**\nAvg confidence: ${signal.avgConfidence}%`;

      const embed = {
        title: `${pairEmoji} ${signal.pair}  ${VOTE_EMOJI[signal.action]} ${signal.action}  ${strength}`,
        color,
        fields: [
          {
            name: '📍 Entry',
            value: `\`${fmt(signal.entry)}\``,
            inline: true
          },
          {
            name: '🛑 Stop Loss',
            value: `\`${fmt(signal.sl)}\``,
            inline: true
          },
          {
            name: '🎯 Take Profit',
            value: `\`${fmt(signal.tp)}\`  (RR 1:${signal.rr})`,
            inline: true
          },
          {
            name: '🗳️ Agent Votes',
            value: voteLines,
            inline: false
          },
          {
            name: '⚖️ Consensus',
            value: consensusText,
            inline: false
          },
          {
            name: '🔍 Context',
            value: `ATR: \`${fmt(signal.atr)}\` | Type: **${signal.type}**`,
            inline: false
          }
        ],
        footer: {
          text: `Voting Agent 🗳️ • ${this._getPKT()}`
        },
        timestamp: new Date().toISOString()
      };

      const body = {
        username:   'Voting Signal Agent 🗳️',
        avatar_url: 'https://i.imgur.com/AfFp7pu.png',
        embeds: [embed]
      };

      await this._postWithRetry(body);
      console.log(`✅ Discord sent: ${signal.pair} ${signal.action} (${signal.voteCount}/3)`);

    } catch (err) {
      console.error('VotingDiscord send failed:', err.message);
    }
  }

  async sendNoConsensus(pair, votes) {
    if (process.env.DEBUG_MODE !== 'true') return;

    const lines = votes.map(v =>
      `${VOTE_EMOJI[v.vote] || '⚪'} ${v.agent}: ${v.vote} — ${v.reason}`
    ).join('\n');

    const body = {
      username: 'Voting Signal Agent 🗳️',
      avatar_url: 'https://i.imgur.com/AfFp7pu.png',
      embeds: [{
        title: `${PAIR_EMOJIS[pair] || '📊'} ${pair} — No Consensus`,
        color: 0x607D8B,
        description: lines,
        footer: { text: `Voting Agent • ${this._getPKT()}` },
        timestamp: new Date().toISOString()
      }]
    };

    try { await this._postWithRetry(body); } catch (_) {}
  }

  _formatPrice(pair, price) {
    if (!price || isNaN(price)) return '—';
    if (pair === 'XAU/USD') return price.toFixed(2);
    if (pair === 'BTC/USD') return price.toFixed(0);
    return price.toFixed(2);
  }

  _getPKT() {
    const now = new Date();
    const pkt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
    return pkt.toISOString().replace('T', ' ').substring(0, 16) + ' PKT';
  }

  async _postWithRetry(body, maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let res;
      try {
        res = await fetch(WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000)
        });
      } catch (err) {
        console.warn(`Discord fetch error (attempt ${attempt}): ${err.message}`);
        await this._sleep(5000 * attempt);
        continue;
      }

      if (res.ok) return;

      if (res.status === 429) {
        let waitMs = 30000;
        try {
          const json = JSON.parse(await res.text());
          if (json.retry_after) waitMs = Math.ceil(json.retry_after * 1000) + 500;
        } catch (_) {}
        console.warn(`Discord rate limit. Waiting ${waitMs}ms...`);
        await this._sleep(waitMs);
        continue;
      }

      throw new Error(`Discord failed: ${res.status}`);
    }
    throw new Error('Discord failed after max retries');
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}
