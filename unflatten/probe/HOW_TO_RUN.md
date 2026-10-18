# How to run the Unflatten Probe

The probe is a small test panel for Photoshop. It checks what Photoshop's own tools can do for Unflatten (Select Subject, Remove Background, Mask All Objects and Content-Aware Fill), and saves the results for comparison with the current engine.

It uses its own test images. **It does not open, change or save any of your files.**

You need **Photoshop 2023 (version 24.2) or newer** and about **10 minutes for setup** (one time only) plus **5–15 minutes** for the test to run.

---

## One-time setup

**1. Install UXP Developer Tools** (Adobe's free tool for loading test plugins).
- Open the **Creative Cloud** desktop app.
- In the search box, type **UXP Developer Tools**.
- Click **Install** on its card.

**2. Start UXP Developer Tools once.**
- On first launch it asks to **Enable Developer Mode**. Click **Enable**.
- Your computer may ask for your password. This is normal and only happens once.

**3. Unzip the probe.**
- Unzip `unflatten-probe.zip`, for example into your **Documents** folder.
- You now have a folder called `unflatten-probe`.

## Run the test

**4. Open Photoshop.** Leave it running. You don't need to open any image.

**5. Load the probe.**
- In **UXP Developer Tools**, click the blue **Add Plugin** button.
- Choose the file **manifest.json** inside the `unflatten-probe` folder.
- **Unflatten Probe** appears in the list. Click the **•••** button next to it and choose **Load**.
- In Photoshop, the **Unflatten Probe** panel opens. If it doesn't, use **Plugins › Unflatten Probe**.

**6. Click "Run safe tests".**
- Then leave Photoshop alone until the panel says **Finished**. Images will open, change and close by themselves.
- If Photoshop shows a message (for example about downloading a selection model, or choosing device or cloud), choose **OK**, or **Device** if asked. Then mention it when you send the results.
- If something goes wrong partway, nothing is lost. Results are saved after every step.

## Send the results

**7.** A folder named **Unflatten Probe Results** followed by today's date is now on your **Desktop**.
- If your Desktop could not be used, Photoshop asks where to save, or the panel shows the folder's location.

**8. Compress that folder into a zip.**
- **Mac:** right-click the folder › **Compress**.
- **Windows:** right-click › **Send to › Compressed (zipped) folder**.

**9. Send me that one zip file.** That is everything I need.

---

### Please don't run unless asked

The panel has a section at the bottom marked **Unsafe test: WebAssembly**. It may close Photoshop (a known issue in Photoshop 2025, version 26.0). It never runs on its own. Skip it unless I ask for it.

### Only if the results ask for it

If my comparison shows that Photoshop's command for a step wasn't found (most likely **Mask All Objects**), I'll ask you to:

1. click **Record a command** in the panel;
2. do that one step by hand on any image;
3. click **Stop recording**;
4. click **Run safe tests** again.

### Afterwards

You can remove the probe at any time. In UXP Developer Tools, use **••• › Unload**, then **Remove**. It installs nothing else.
