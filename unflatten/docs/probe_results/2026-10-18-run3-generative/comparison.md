# Photoshop vs engine

Photoshop 27.11.0 · UXP uxp-9.4.1-0 · darwin 24.6.0 x64 · probe 0.4.1


## Subjects

| Image | People | Photoshop Select Subject | s | Mask All Objects | Engine people | Agreement IoU (Select Subject / Remove Background) | Cap in subject (PS / engine) |
|---|---|---|---|---|---|---|---|

Engine layers per image: 

## Background on Photoshop's own hole

| Image | Hole | People left (PS / engine) | Seam (PS / engine) | Match ΔE (PS / engine) | Detail (PS / engine) | PS s | PS changed outside |
|---|---|---|---|---|---|---|---|

## Known-truth scenes (PSNR vs the real background; higher is better)

| Scene | Hole | Photoshop dB | Engine dB | Seam PS / engine | PS s |
|---|---|---|---|---|---|

## Generative: Generative Fill, Remove tool and Content-Aware Fill on one hole

Same measures as the fill strategies above. Changed outside: share of pixels outside the hole the command altered (should be 0).

| Image | Hole | Method | s | Seam | Match ΔE | Detail | Changed outside | People left / PSNR |
|---|---|---|---|---|---|---|---|---|
| A_wall | 0.336 | Generative Fill | 9.4 | 1.096 | 3.6 | 0.86 | 0.0144 | 0 |
| A_wall | 0.336 | Remove tool | failed: not recorded yet | | | | | |
| A_wall | 0.336 | Content-Aware Fill | 1.9 | 1.408 | 0.5 | 0.91 | 0 | 0 |
| A_wall | 0.336 | engine (lama) | – | 2.26 | 1.3 | 0.76 | – | 0 |
| B_cap_red | 0.504 | Generative Fill | 10.5 | 1.046 | 4.9 | 0.67 | 0.0113 | 0 |
| B_cap_red | 0.504 | Remove tool | failed: not recorded yet | | | | | |
| B_cap_red | 0.504 | Content-Aware Fill | 4.8 | 1.191 | 7.4 | 0.96 | 0 | 0 |
| B_cap_red | 0.504 | engine (lama) | – | 2.607 | 5.1 | 0.4 | – | 0 |
| B_cap_black | 0.323 | Generative Fill | 9.5 | 1.604 | 5.1 | 0.63 | 0.0135 | 0 |
| B_cap_black | 0.323 | Remove tool | failed: not recorded yet | | | | | |
| B_cap_black | 0.323 | Content-Aware Fill | 2.1 | 1.726 | 4.3 | 0.49 | 0 | 0 |
| B_cap_black | 0.323 | engine (lama) | – | 1.909 | 5.7 | 0.31 | – | 0 |
| C_crew | 0.518 | Generative Fill | 11.3 | 1.163 | 3.4 | 0.76 | 0.0132 | 0 |
| C_crew | 0.518 | Remove tool | failed: not recorded yet | | | | | |
| C_crew | 0.518 | Content-Aware Fill | 3.1 | 1.586 | 5.8 | 0.87 | 0 | 0 |
| C_crew | 0.518 | engine (lama) | – | 2.585 | 3.8 | 0.28 | – | 0 |
| C_family | 0.495 | Generative Fill | 9.0 | 0.945 | 8.9 | 1.06 | 0.003 | 0 |
| C_family | 0.495 | Remove tool | failed: not recorded yet | | | | | |
| C_family | 0.495 | Content-Aware Fill | 2.9 | 1.817 | 5.9 | 0.65 | 0 | 0 |
| C_family | 0.495 | engine (lama) | – | 2.365 | 13.6 | 0.49 | – | 0 |
| D_philadelphia | 0.209 | Generative Fill | 11.9 | 1.113 | 1.2 | 0.88 | 0.0223 | 0 |
| D_philadelphia | 0.209 | Remove tool | failed: not recorded yet | | | | | |
| D_philadelphia | 0.209 | Content-Aware Fill | 3.5 | 1.102 | 0.3 | 0.82 | 0 | 0 |
| D_philadelphia | 0.209 | engine (lama) | – | 1.352 | 0.1 | 0.33 | – | 0 |
| D_rosie | 0.54 | Generative Fill | 9.6 | 0.706 | 20.4 | 1.31 | 0.0161 | 0 |
| D_rosie | 0.54 | Remove tool | failed: not recorded yet | | | | | |
| D_rosie | 0.54 | Content-Aware Fill | 3.6 | 0.986 | 7.4 | 0.79 | 0 | 0 |
| D_rosie | 0.54 | engine (lama) | – | 1.634 | 9.5 | 0.26 | – | 0 |
| scene: brick wall, large hole | 0.587 | Generative Fill | 7.9 | 0.912 | 0.9 | 0.89 | 0.0138 | 22.75 |
| scene: brick wall, large hole | 0.587 | Remove tool | failed: not recorded yet | | | | | |
| scene: brick wall, large hole | 0.587 | Content-Aware Fill | 3.0 | 0.844 | 1.2 | 0.98 | 0 | 16.07 |
| scene: brick wall, large hole | 0.587 | engine (lama) | – | 1.17 | 5.1 | 0.66 | – | 21.79 |
| scene: brick wall, 3 figures | 0.479 | Generative Fill | 7.7 | 1.063 | 0.9 | 0.9 | 0.0272 | 26.13 |
| scene: brick wall, 3 figures | 0.479 | Remove tool | failed: not recorded yet | | | | | |
| scene: brick wall, 3 figures | 0.479 | Content-Aware Fill | 2.6 | 1.076 | 1.4 | 1.0 | 0 | 16.34 |
| scene: brick wall, 3 figures | 0.479 | engine (lama) | – | 1.395 | 3.1 | 0.72 | – | 23.09 |

## Enhance Edge vs plain Remove Background

Enhance Edge makes a new layer with the same mask and cleaned edge colours; see the `_edge.png` cut-outs on magenta.

| Image | s | Result on | Mask pixels changed | Edge pixels | Mean colour change on the edge (0–255) |
|---|---|---|---|---|---|
| A_wall | 6.4 | new layer | 0 | 15634 | 18.34 |
| B_cap_red | 8.5 | new layer | 0 | 31203 | 32.56 |
| C_family | 7.2 | new layer | 0 | 24345 | 38.2 |

Generative commands replayed from recordings: {'fill': ['recorded syntheticFill #1', 'recorded syntheticFill #1 (no target)', 'recorded syntheticFill #2', 'recorded syntheticFill #2 (no target)'], 'remove': [], 'edge': ['recorded modernRefineEdge #1']}

Recorded commands: ['autoCutout', 'historyStateChanged', 'hostFocusChanged', 'invokeCommand', 'modalStateChanged', 'modernRefineEdge', 'owlAction', 'pifInvalidatedAttributes', 'progressBarVisibility', 'removeBackground', 'select', 'set', 'syntheticFill']
