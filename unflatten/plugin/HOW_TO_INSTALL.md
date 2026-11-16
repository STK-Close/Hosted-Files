# Unflatten for Photoshop, version 1

One button turns a flattened photo into separate, transparent layers:
- each person or object gets its own layer;
- the background behind them is rebuilt, with no holes or ghosts;
- the original is kept as a hidden layer at the bottom.

The visible layers recombine to exactly the original image. One **Undo** (Edit › Undo Unflatten) takes it all back.

You need **Photoshop 2024 (version 25) or newer**. The probe tests ran on Photoshop 27.11.

## Install (one time)

You already have **UXP Developer Tools** from the probe tests.

1. Unzip `unflatten-plugin.zip`, for example into **Documents**. You get a folder called `unflatten-plugin`.
2. In **UXP Developer Tools**, click **Add Plugin**, choose `manifest.json` inside `unflatten-plugin`, then **••• › Load**.
3. In Photoshop, the **Unflatten** panel opens. If it doesn't, use **Plugins › Unflatten**.

## Use

1. Open a photo.
2. Click **Unflatten** and wait. It takes about 15–40 seconds, most of it Generative Fill. Photoshop may look busy meanwhile.
3. The new layers appear:
   - **Subject 1**, **Subject 2** and so on, left to right, each on a transparent background;
   - **Background (rebuilt)** under them;
   - **Original (flattened)**, hidden, at the bottom.

**Generative Fill (uses Adobe credits)** is ticked by default. Each Unflatten normally uses one Generative Fill, occasionally two.
- The plugin checks every rebuilt background against its surroundings. If Generative Fill invents something, or isn't available (no credits, offline), it uses Content-Aware Fill instead, which is free.
- Flat graphics always use Content-Aware Fill.
- Untick the box to always use the free method.

The panel's last line says which method was used.

## Not in version 1 yet

These come with the next update:
- **Descriptive names** ("Person Wearing Baseball Cap", "Flag", "Chair"). Version 1 says "Subject 1", "Subject 2".
- **Book covers and full-frame graphics.** Version 1 says so and leaves the image unchanged.
- **Editable text layers.**

## If something goes wrong

The panel says what happened, and the image is left exactly as it was. Send me a screenshot of the panel. For an image that comes out badly, send the image too if you can.
