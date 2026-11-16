# Text-first prototype

Local models only (no outside service):

```bash
pip install rapidocr_onnxruntime
python text_masks.py cover.png out/   # find, read and cut every line of lettering
python layers.py cover.png out/       # lift the text, fill behind it, separate subjects; writes out/sheet.png
```

- `text_masks.py`: PP-OCR at three scales (large titles are only read whole when the image is shrunk), then one SAM 2.1 box prompt per line on a zoomed crop.
- `layers.py`: LaMa fills behind the lettering; the engine's subject pipeline then runs on the text-free image. In the plugin, Generative Fill and Photoshop's object masks take those two roles.

Measured on three book covers (16 November 2026): every line and title word found and read; lettering removed cleanly in 7–11 s on CPU. Subject separation on the text-free image was good on a portrait and a crown, poor on a hand holding a knife.
