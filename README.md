# Token Radar 01 — Size Curve + Launch Odds

[![make.fun badge](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/nuraliana/maple-orchard-16/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/nuraliana/maple-orchard-16/reward.svg)](https://make.fun/bounty/token-radar-01)

This board ranks 198 pre-token protocols by expected value. Each protocol's conditional value comes from a log-log size curve fitted on 109 traded comps, multiplied by launch odds from a piecewise-constant hazard model. Every row carries a concrete farm plan: what it costs, how long it takes, and the stop and exit rules that apply.

## Model

Value comes from an OLS fit of log(mcap) on log(TVL): log(mcap) = 4.5680 + 0.6761·log(TVL). The fit uses neither age nor a category offset, because both failed the 3-leg guard. The implied multiple is clamped to [0.08, 1.20], then scaled by a 0.85 pre-token discount. Growth weight is 0: the same 3-leg guard rejected w=0.3, where LOO did not move while time-split and walk-forward both got worse.

Validation is reported as geometric factor-miss: leave-one-out 3.478×, time-split 3.188×, walk-forward 3.177×. That beats both baselines — a flat TVL multiple and a median multiple — on all three legs.

Launch odds use hazards of [0.9393, 0.05, 0.05, 0.8393, 0.05, 0.6291] per year across six age bins, times a shrunk category multiplier, giving P(launch within 2 years | not yet launched). On a 70/30 validation split (seed 20261114) the model scores a 64.2% hit rate and a Brier of 0.2227 against a 53.4% base rate.

Farm math takes a slice of EV × 0.0025%, nets it to the lower end of the model band (4.65×), then subtracts $14 of gas and the 4% T-bill return on a $200 deposit over 90 days. The verdicts follow net value: Farm at ≥ $60 net, Thin above $0, Skip at ≤ $0.

## Honest weak legs

Age loses to no-age on all three legs. Age transforms were tried — floors, caps, log1p, sqrt, linear — and none of them beat no-age on all three legs, so age is dropped entirely. Category offsets lose to dropping them on LOO (3.478 vs 3.510), time-split (3.188 vs 3.264), and the 3-leg average (3.281 vs 3.315), trailing only on walk-forward by 0.005, so the final model has no offset. Variant A (no-age + offsets k=8) and variant B (no-age, no offsets) are both measured in NOTES-v3.md. Launch odds beat the ever-rate comparator narrowly on hit rate but lose narrowly on Brier (0.2227 vs 0.2122) on the reported split.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Requires Node 22+, stdlib only, no network, deterministic (seeded PRNG: split seed 20261114, bootstrap seed 20261119). It writes board.json, data.js, dashboard/, screenshots/, dossier.json to the output directory. See NOTES-v3.md (beside the spec, outside this entry) for the full build log.

## License

MIT — see LICENSE.
