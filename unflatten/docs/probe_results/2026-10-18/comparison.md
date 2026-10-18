# Photoshop vs engine

Photoshop 27.1.0 · UXP uxp-9.0.2-uxp1-e0d9ef0 · darwin 24.6.0 x64 · probe 0.2.4


## Subjects

| Image | People | Photoshop Select Subject | s | Mask All Objects | Engine people | Agreement IoU (Select Subject / Remove Background) | Cap in subject (PS / engine) |
|---|---|---|---|---|---|---|---|
| A_wall | 1 | 1 piece(s) | 2.7 | 2 object layers | 1 | 0.773 / 0.773 | – |
| B_cap_red | 1 | 1 piece(s) | 2.2 | 3 object layers | 1 | 0.734 / 0.734 | 0.75 / 0.76 |
| B_cap_black | 1 | 1 piece(s) | 1.9 | 1 object layers | 1 | 0.887 / 0.887 | 0.75 / 0.75 |
| C_crew | 5 | 1 piece(s) | 2.2 | 11 object layers | 5 | 0.797 / 0.797 | – |
| C_family | 6 | 1 piece(s) | 2.1 | 6 object layers | 6 | 0.913 / 0.913 | – |
| D_simian | 0 | 1 piece(s) | 2.6 | 1 object layers | 1 | 0.003 / 0.003 | – |
| D_philadelphia | 0 | 2 piece(s) | 10.9 | 1 object layers | 0 | – / – | – |
| D_rosie | 1 | 1 piece(s) | 2.2 | 1 object layers | 1 | 0.924 / 0.924 | – |

Engine layers per image: **A_wall**: Person Wearing Hat; **B_cap_red**: Person Wearing Baseball Cap; **B_cap_black**: Person Wearing Baseball Cap, Title Text, Text 1, Text 2, Small Text 1, Small Text 2; **C_crew**: Flag 1, Flag 2, Person 1, Person 2, Person 3, Person 4, Person 5, Chair 1, Chair 2, Table, Lamp; **C_family**: Person 1, Person 2, Person 3, Person 4, Person 5, Person 6, Smoke; **D_simian**: Dog 1, Horse, Speech Bubble, Dog 2, Title Text, Text 1, Book, Person, Text 2; **D_philadelphia**: Castle, Title Text, Small Text 1, Text, Small Text 2, Small Text 3, Small Text 4; **D_rosie**: Person Wearing Hat, Text

## Separate objects: Photoshop Mask All Objects vs engine layers

Each engine layer is paired with the Photoshop object it overlaps most (each object used once); a pair counts as the same object at IoU ≥ 0.5.

| Image | People | PS objects | Engine layers | Engine people matched by a PS object | All layers matched | Per layer IoU |
|---|---|---|---|---|---|---|
| A_wall | 1 | 2 | 1 | 1 of 1 | 1 of 1 | Person Wearing Hat 0.77 |
| B_cap_red | 1 | 3 | 1 | 1 of 1 | 1 of 1 | Person Wearing Baseball Cap 0.73 |
| B_cap_black | 1 | 1 | 6 | 1 of 1 | 1 of 6 | Person Wearing Baseball Cap 0.89, Title Text 0.0, Text 1 0.0, Text 2 0.0, Small Text 1 0.0, Small Text 2 0.0 |
| C_crew | 5 | 11 | 11 | 5 of 5 | 9 of 11 | Flag 1 0.68, Flag 2 0.57, Person 1 0.83, Person 2 0.82, Person 3 0.94, Person 4 0.89, Person 5 0.63, Chair 1 0.86, Chair 2 0.89, Table 0.39, Lamp 0.0 |
| C_family | 6 | 6 | 7 | 6 of 6 | 6 of 7 | Person 1 0.9, Person 2 0.96, Person 3 0.81, Person 4 0.92, Person 5 0.88, Person 6 0.94, Smoke 0.0 |
| D_simian | 0 | 1 | 9 | 0 of 1 | 0 of 9 | Dog 1 0.01, Horse 0.0, Speech Bubble 0.0, Dog 2 0.0, Title Text 0.0, Text 1 0.0, Book 0.0, Person 0.0, Text 2 0.0 |
| D_philadelphia | 0 | 1 | 7 | 0 of 0 | 0 of 7 | Castle 0.05, Title Text 0.0, Small Text 1 0.0, Text 0.0, Small Text 2 0.0, Small Text 3 0.0, Small Text 4 0.0 |
| D_rosie | 1 | 1 | 2 | 1 of 1 | 1 of 2 | Person Wearing Hat 0.92, Text 0.0 |

## Background on Photoshop's own hole

| Image | Hole | People left (PS / engine) | Seam (PS / engine) | Match ΔE (PS / engine) | Detail (PS / engine) | PS s | PS changed outside |
|---|---|---|---|---|---|---|---|
| A_wall | 0.335 | 0 / 0 | 1.705 / 2.352 | 0.7 / 1.4 | 0.9 / 0.77 | 1.7 | 0 |
| B_cap_red | 0.503 | 0 / 0 | 1.271 / 2.618 | 8.2 / 5.1 | 0.95 / 0.4 | 4.0 | 0 |
| B_cap_black | 0.322 | 0 / 0 | 1.526 / 1.878 | 4.5 / 5.7 | 0.5 / 0.31 | 1.7 | 0 |
| C_crew | 0.47 | 0 / 0 | 1.498 / 2.291 | 3.3 / 7.4 | 1.06 / 0.26 | 2.7 | 0 |
| C_family | 0.492 | 0 / 0 | 1.87 / 2.394 | 6.3 / 14.3 | 0.64 / 0.49 | 2.7 | 0 |
| D_simian | – | Photoshop failed: Error: fill contentAware + colour adaptation: error | fill contentAware: error | | | | | |
| D_philadelphia | 0.205 | 0 / 0 | 1.142 / 1.393 | 0.4 / 0.6 | 0.73 / 0.31 | 2.7 | 0 |
| D_rosie | 0.538 | 0 / 0 | 1.02 / 1.584 | 7.5 / 9.3 | 0.77 / 0.26 | 3.2 | 0 |

## Known-truth scenes (PSNR vs the real background; higher is better)

| Scene | Hole | Photoshop dB | Engine dB | Seam PS / engine | PS s |
|---|---|---|---|---|---|
| blue wall | 0.194 | 37.93 | 38.43 | 0.887 / 0.919 | 0.9 |
| brick wall | 0.194 | 18.79 | 24.87 | 0.928 / 1.283 | 1.1 |
| paper | 0.194 | 31.96 | 32.66 | 0.915 / 0.958 | 1.1 |
| brick wall, large hole | 0.561 | 16.46 | 21.82 | 1.026 / 1.573 | 2.4 |

Recorded commands: ['autoMaskGenerate', 'historyStateChanged', 'invokeCommand']
