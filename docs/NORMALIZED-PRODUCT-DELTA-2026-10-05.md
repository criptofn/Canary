# Windows content comparison correction

## Evidence from the frozen native comparison

Four sessions used the frozen source `7ecf465`, installed entry SHA-256
`10c482d22ac12c6c951b859d1dedf628c932be1251ebf21488a61528f1237805`.
Capture: `legacy-build-freshness-20261005-native-h1h2-job/capture`, under
`C:/Users/Johannes/Desktop/canary/_canary-data/evidence`.

| Session | Independent correctness | Normal completion | Native tokens | Seconds |
| --- | --- | --- | ---: | ---: |
| H1/plain | pass | yes | 31,795 | 39.761 |
| H1/Canary | pass | no: turn limit | 1,395,606 | 398.144 |
| H2/Canary | pass | yes: real Stop pass | 550,676 | 214.924 |
| H2/plain | pass | yes | 178,070 | 52.595 |

All four captures have reconciled native accounting, unchanged protected
configuration, preserved baseline ancestry and zero in-session manual
interventions. Provider charge is zero. Capture completion does not turn
H1's `error_max_turns` into success. This partial comparison is four of the
original twelve sessions and does not establish an 8/10 rating or token savings.
H2 now completes correctly with its protected setup intact; its earlier failed
trial remains a separate cohort.

## Confirmed H1 false block

The H1 worker committed its covered implementation fix, then changed tests and
rewrote the source file without changing its Git-normalized contents. `git
status` still reported that source as modified, while `git diff HEAD` reported
only the test change. Git's blob IDs for raw and normalized working source,
index and HEAD all matched `eee72aa66d2ffb8d9cb53627bbaafdd3a9d59a12`.

Canary used the status-only production path to select HEAD as an additional
comparison base. That commit already contained the fix, so the tests passed
there and correct, covered work was unnecessarily blocked. The mandatory sealed
baseline comparison had already discriminated the fix; otherwise the additional
comparison branch could not have been reached.

The preserved post-session old-product diagnostic reproduces NOT PROVEN in
`legacy-build-freshness-20261005-frozen/h1-post-session-diagnostic`. Four worker
states were archived beforehand (80 hashed files). No native outcome was edited.

## Product correction and countercases

The shared `planDiscrimination` function now chooses the latest comparison base
from Git's actual tracked content delta against HEAD, plus explicitly enumerated
untracked files. Status-only LF/CRLF dirt cannot masquerade as a new product
change. The original sealed comparison remains mandatory. Actual later source
changes and new uncovered production files still require discriminating checks;
worker-authored tests retain their provenance caveat.

The real-Git regression reproduces normalized-equal source dirt with a CRLF
checkout. Before the change it reaches the erroneous NOT PROVEN (exit 2 rather
than zero): `normalized-product-delta-20261005-fixture-red3.log`. The two earlier
fixture logs failed to establish the premise and are not product red proofs.
Targeted green logs exercise doctor, Stop, untracked and tracked countercases,
plus the existing consecutive-change protection.

A direct recheck of the original H1 tree with a development CLI at a different
path was refused by the installation ownership guard. Its misleadingly named
`normalized-product-delta-20261005-native-h1-green` capture is **not** a green
verification. The ownership refusal is preserved; no config was resealed and no
frozen installation was overwritten. The controlled regression uses a correctly
owned installation. Full sequential gates and a new installed artifact for this
additional correction remain pending.

## Delivered correction

Product source `a77acf9` completed the required standalone suite (1354 pass,
zero fail, four explicit skips) and productization (104 pass, six explicit skips)
sequentially. The gate ended at 2026-10-05T13:22:12.779Z with status zero, no
signal and no execution error. The frozen archive hash is
`be58e82ef213612edb9899066149caa22572113041022536fa21011c543baf0d`;
installed entry hash is
`1cb802b88186ad04fd15cde857d5e6cbcdf1ead28353001af2727af88c0b730f`.

The existing regression now accepts an explicit absolute `CANARY_TEST_CLI`
(test-only commit `dd74819`); malformed selection is refused rather than falling
back. It reproduces exit 2 instead of zero against the older installed entry
`10c482d2...7805`, then passes against the newly installed entry, including real
source/untracked countercases, Doctor/Stop and worker provenance. This uses fresh
fixtures sealed by their selected installations and preserves the original H1
native outcome. Captures and exact hashes are in
`normalized-product-delta-20261005-frozen/installed-normalized-receipt.json`.
Status controls, seven provenance observations and eleven build-order
observations also pass on that installed artifact. The user requested a closing
report and then a goal pause; no new native pilot follows this delivery.
