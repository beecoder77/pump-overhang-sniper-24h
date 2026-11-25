# pump-overhang-sniper-24h

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/beecoder77/pump-overhang-sniper-24h/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/beecoder77/pump-overhang-sniper-24h/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Paper trading bot for the make.fun pump.fun replay sprint (jackxyz72, 24h horizon).

Same engine as the 6h boothlord entry (beecoder77/pump-overhang-sniper):
one engine, two horizon settings. Only the horizon numbers differ
(paceSecs 86,400 for the 24h window; maxHold stays 400 — the backtester
showed longer holds are worse even on 24h).

## Strategy — Breakout Rider

- **Entry:** a mint whose recent 10-slot high crosses **3.5x** its first-trade
  price, within **600 slots** of creation, real SOL reserves 20–200, and
  the creator never sold.
- **Exit:** a **fixed 400-slot hold only**. Every reactive exit (stop, trail,
  big-sell, take-profit) is disabled — the price path is a violent whipsaw
  and they all fire on noise.
- **Pyramid:** adds only into confirmed strength — position already up ≥10%,
  price stepped up ≥5% from the last add, net SOL still flowing in over
  the last 30 slots. Losers stay at the 0.3 SOL initial stake; winners
  build to the full 5 SOL stake.
- **Guardrail:** 0.02 SOL probe round-trips paced to 30 coins / 300 fills
  over 24h.

## Local scores (grade-local, process driver, dev window)

- Net PnL **+7.77 SOL**, max drawdown **32.0%** (limit 50%)
- PnL at 2x fees **+5.55 SOL**
- 325 fills, 77 distinct mints, 98 counted round-trips
- Guardrails: compliant (drawdown, fills, mints all pass)
- Determinism: action logs reproduced (`l1.reproduced: true`)
- Bootstrap interval (90%): low **−5.27 SOL**, high +20.57 SOL — the PnL
  is concentrated in the top 3 completing coins (47% of gains)
- Stress: same engine as the 6h entry; the 6h stress (20 block-surrogate
  copies) gave median −6.30 SOL, 18/20 losing — see that repo's README.
  The block surrogate destroys the completion-path persistence the edge
  relies on; the eval window is real trades, so the dev score is the
  relevant predictor.

## Files

- `main.ts` — the bot (Node 22, `vendor/makefun-bot.ts` SDK shim)
- `vendor/makefun-bot.ts` — kit-mandated shim, copied unchanged from the kit

---

<sub>Entered on [make.fun](https://make.fun/?ref=ws337zp2&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
