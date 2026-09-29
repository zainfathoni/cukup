"""Synthesizes one narration clip per line with Kokoro, locally.

    python voice.py LINES.json OUT_DIR

LINES.json is a list of {"key", "text"}. Writes OUT_DIR/<key>.wav and prints
{"<key>": seconds} as JSON. Run it through scripts/voice.ts, not directly.

KOKORO_DIR must hold kokoro-v1.0.onnx and voices-v1.0.bin.
"""

import json
import os
import re
import sys

import soundfile
from kokoro_onnx import Kokoro

VOICE = "af_heart"
SPEED = 0.94
LANG = "en-us"

# English rules read "Cukup" as "kyoo-kup". Indonesian says "CHOO-koop".
CUKUP_ENGLISH = "kjˈuːkʌp"
CUKUP_INDONESIAN = "tʃˈuːkʊp"


def phonemes(kokoro: Kokoro, text: str) -> str:
    result = kokoro.tokenizer.phonemize(text, LANG)
    expected = len(re.findall(r"\bcukup\b", text, re.IGNORECASE))
    if result.count(CUKUP_ENGLISH) != expected:
        raise SystemExit(f"Could not find the phonemes of 'Cukup' in: {text!r} -> {result!r}")
    return result.replace(CUKUP_ENGLISH, CUKUP_INDONESIAN)


def main() -> None:
    lines_path, out_dir = sys.argv[1], sys.argv[2]
    model_dir = os.environ["KOKORO_DIR"]
    kokoro = Kokoro(os.path.join(model_dir, "kokoro-v1.0.onnx"), os.path.join(model_dir, "voices-v1.0.bin"))
    with open(lines_path, encoding="utf-8") as file:
        lines = json.load(file)
    durations = {}
    for line in lines:
        samples, rate = kokoro.create(phonemes(kokoro, line["text"]), voice=VOICE, speed=SPEED, is_phonemes=True)
        soundfile.write(os.path.join(out_dir, f"{line['key']}.wav"), samples, rate, subtype="PCM_16")
        durations[line["key"]] = round(len(samples) / rate, 3)
    print(json.dumps({"voice": VOICE, "speed": SPEED, "durations": durations}))


if __name__ == "__main__":
    main()
