# Photoshop vs engine

Photoshop 27.11.0 · UXP uxp-9.4.1-0 · darwin 24.6.0 x64 · probe 0.3.0


## Subjects

| Image | People | Photoshop Select Subject | s | Mask All Objects | Engine people | Agreement IoU (Select Subject / Remove Background) | Cap in subject (PS / engine) |
|---|---|---|---|---|---|---|---|
| A_wall | 1 | 1 piece(s) | 2.6 | 2 object layers | 1 | 0.773 / 0.773 | – |
| B_cap_red | 1 | 1 piece(s) | 2.5 | 3 object layers | 1 | 0.734 / 0.734 | 0.75 / 0.76 |
| B_cap_black | 1 | 1 piece(s) | 2.0 | 1 object layers | 1 | 0.887 / 0.887 | 0.75 / 0.75 |
| C_crew | 5 | 1 piece(s) | 2.7 | 11 object layers | 5 | 0.797 / 0.797 | – |
| C_family | 6 | 1 piece(s) | 2.5 | 6 object layers | 6 | 0.913 / 0.913 | – |
| D_simian | 0 | 1 piece(s) | 3.0 | 1 object layers | 1 | 0.003 / 0.003 | – |
| D_philadelphia | 0 | 1 piece(s) | 12.6 | 1 object layers | 0 | – / – | – |
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
| A_wall | 0.335 | 0 / 0 | 1.705 / 2.352 | 0.7 / 1.4 | 0.9 / 0.77 | 2.0 | 0 |
| B_cap_red | 0.503 | 0 / 0 | 1.271 / 2.618 | 8.2 / 5.1 | 0.95 / 0.4 | 4.9 | 0 |
| B_cap_black | 0.322 | 0 / 0 | 1.526 / 1.878 | 4.5 / 5.7 | 0.5 / 0.31 | 1.9 | 0 |
| C_crew | 0.47 | 0 / 0 | 1.498 / 2.291 | 3.3 / 7.4 | 1.06 / 0.26 | 3.1 | 0 |
| C_family | 0.492 | 0 / 0 | 1.87 / 2.394 | 6.3 / 14.3 | 0.64 / 0.49 | 2.4 | 0 |
| D_simian | – | Photoshop failed: skipped: hole covers 100% of the image | | | | | |
| D_philadelphia | 0.209 | 0 / 0 | 1.113 / 1.352 | 0.3 / 0.1 | 0.8 / 0.33 | 2.7 | 0 |
| D_rosie | 0.538 | 0 / 0 | 1.02 / 1.584 | 7.5 / 9.3 | 0.77 / 0.26 | 3.4 | 0 |

## Known-truth scenes (PSNR vs the real background; higher is better)

| Scene | Hole | Photoshop dB | Engine dB | Seam PS / engine | PS s |
|---|---|---|---|---|---|
| blue wall | 0.194 | 37.93 | 38.43 | 0.887 / 0.919 | 1.9 |
| brick wall | 0.194 | 18.79 | 24.87 | 0.928 / 1.283 | 1.7 |
| paper | 0.194 | 31.96 | 32.66 | 0.915 / 0.958 | 2.0 |
| brick wall, large hole | 0.561 | 16.46 | 21.82 | 1.026 / 1.573 | 4.2 |
| brick wall, 3 figures | 0.426 | 17.29 | 23.67 | 1.065 / 1.625 | 3.5 |

## Large holes: fill strategies on the same hole

Seam: 1.0 = invisible. Match ΔE: colour difference to the surroundings. Detail: texture vs the surroundings (1.0 = same; low = blurred; well above 1 can mean pasted structure). People left: anyone still detectable. On scenes, PSNR against the true background (higher is better). Judge with the pictures too.

| Image | Hole | Strategy | Fills | s | Seam | Match ΔE | Detail | People left / PSNR |
|---|---|---|---|---|---|---|---|---|
| A_wall | 0.336 | all at once | 1 | 2.0 | 1.615 | 0.6 | 0.88 | 0 |
| A_wall | 0.336 | all at once, cleared | 1 | 2.2 | 1.615 | 0.6 | 0.88 | 0 |
| A_wall | 0.336 | one object at a time | 3 | 2.7 | 1.777 | 0.6 | 0.83 | 0 |
| A_wall | 0.336 | rings from the edge | 6 | 4.7 | 1.672 | 0.7 | 0.9 | 0 |
| A_wall | 0.336 | engine (lama) | – | – | 2.26 | 1.3 | 0.76 | 0 |
| B_cap_black | 0.323 | all at once | 1 | 1.9 | 1.789 | 4.3 | 0.48 | 0 |
| B_cap_black | 0.323 | all at once, cleared | 1 | 2.3 | 1.789 | 4.3 | 0.48 | 0 |
| B_cap_black | 0.323 | one object at a time | 2 | 2.4 | 1.861 | 4.5 | 0.48 | 0 |
| B_cap_black | 0.323 | rings from the edge | 9 | 6.6 | 1.762 | 5.2 | 0.51 | 0 |
| B_cap_black | 0.323 | engine (lama) | – | – | 1.909 | 5.7 | 0.31 | 0 |
| C_crew | 0.732 | all at once | 1 | 4.2 | 2.733 | 3.7 | 0.59 | 0 |
| C_crew | 0.732 | all at once, cleared | 1 | 4.8 | 2.733 | 3.7 | 0.59 | 0 |
| C_crew | 0.732 | one object at a time | 12 | 12.0 | 3.317 | 3.5 | 0.51 | 0 |
| C_crew | 0.732 | rings from the edge | 7 | 11.2 | 3.021 | 3.5 | 0.52 | 0 |
| C_crew | 0.732 | engine (lama) | – | – | 4.06 | 5.1 | 0.45 | 0 |
| C_family | 0.495 | all at once | 1 | 2.4 | 1.823 | 5.9 | 0.65 | 0 |
| C_family | 0.495 | all at once, cleared | 1 | 2.9 | 1.823 | 5.9 | 0.65 | 0 |
| C_family | 0.495 | one object at a time | 7 | 6.4 | 1.729 | 7.7 | 0.65 | 0 |
| C_family | 0.495 | rings from the edge | 7 | 7.1 | 1.907 | 7.3 | 0.73 | 0 |
| C_family | 0.495 | engine (lama) | – | – | 2.365 | 13.6 | 0.49 | 0 |
| D_philadelphia | 0.209 | all at once | 1 | 2.5 | 1.113 | 0.3 | 0.8 | 0 |
| D_philadelphia | 0.209 | all at once, cleared | 1 | 2.6 | 1.113 | 0.3 | 0.8 | 0 |
| D_philadelphia | 0.209 | one object at a time | 1 | 2.8 | 1.113 | 0.3 | 0.8 | 0 |
| D_philadelphia | 0.209 | rings from the edge | 5 | 4.4 | 1.139 | 0.3 | 0.85 | 0 |
| D_philadelphia | 0.209 | engine (lama) | – | – | 1.352 | 0.1 | 0.33 | 0 |
| D_rosie | 0.54 | all at once | 1 | 3.5 | 1.048 | 7.4 | 0.77 | 0 |
| D_rosie | 0.54 | all at once, cleared | 1 | 4.1 | 1.048 | 7.4 | 0.77 | 0 |
| D_rosie | 0.54 | one object at a time | 2 | 6.3 | 1.163 | 7.3 | 0.79 | 0 |
| D_rosie | 0.54 | rings from the edge | 6 | 13.7 | 1.17 | 9.1 | 0.8 | 0 |
| D_rosie | 0.54 | engine (lama) | – | – | 1.634 | 9.5 | 0.26 | 0 |
| scene: brick wall, large hole | 0.587 | all at once | 1 | 4.5 | 0.842 | 1.2 | 0.98 | 16.07 |
| scene: brick wall, large hole | 0.587 | all at once, cleared | 1 | 4.9 | 0.842 | 1.2 | 0.98 | 16.07 |
| scene: brick wall, large hole | 0.587 | one object at a time | 2 | 4.4 | 0.934 | 1.2 | 1.0 | 13.52 |
| scene: brick wall, large hole | 0.587 | rings from the edge | 11 | 11.9 | 0.879 | 3.4 | 0.79 | 14.98 |
| scene: brick wall, large hole | 0.587 | engine (lama) | – | – | 1.17 | 5.1 | 0.66 | 21.79 |
| scene: brick wall, 3 figures | 0.479 | all at once | 1 | 3.3 | 1.073 | 1.4 | 1.0 | 16.34 |
| scene: brick wall, 3 figures | 0.479 | all at once, cleared | 1 | 3.4 | 1.073 | 1.4 | 1.0 | 16.34 |
| scene: brick wall, 3 figures | 0.479 | one object at a time | 4 | 3.9 | 1.426 | 1.3 | 0.88 | 14.03 |
| scene: brick wall, 3 figures | 0.479 | rings from the edge | 5 | 6.0 | 1.145 | 2.0 | 0.91 | 15.09 |
| scene: brick wall, 3 figures | 0.479 | engine (lama) | – | – | 1.395 | 3.1 | 0.72 | 23.09 |
