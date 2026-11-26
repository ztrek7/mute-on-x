"""Choose the extension's actual browser menu item on a private Xvfb display."""
import ctypes
import os
from pathlib import Path
import re
import subprocess
import time

display = re.fullmatch(r":(\d+)(?:\.\d+)?", os.environ.get("DISPLAY", ""))
if not display:
    raise SystemExit("Use xvfb-run for the native menu test.")
pid = Path(f"/tmp/.X{display[1]}-lock").read_text().strip()
if Path(f"/proc/{pid}/exe").resolve().name != "Xvfb":
    raise SystemExit("The native menu test needs its own Xvfb display.")

x11 = ctypes.CDLL("libX11.so.6")
xtest = ctypes.CDLL("libXtst.so.6")
x11.XOpenDisplay.restype = ctypes.c_void_p
connection = ctypes.c_void_p(x11.XOpenDisplay(None))
if not connection:
    raise SystemExit("Could not open the fixture display.")

for attempt in range(5):
    screenshot = subprocess.check_output(["import", "-window", "root", "png:-"])
    output = subprocess.check_output(
        ["tesseract", "stdin", "stdout", "--psm", "11", "tsv"],
        input=screenshot, stderr=subprocess.DEVNULL,
    ).decode()
    words = [line.split("\t") for line in output.splitlines() if line.startswith("5\t")]
    for i, row in enumerate(words):
        if [word[-1].lower() for word in words[i:i + 3]] == ["mute", "on", "x"]:
            x, y, width, height = map(int, row[6:10])
            xtest.XTestFakeMotionEvent(connection, -1, x + width // 2, y + height // 2, 0)
            xtest.XTestFakeButtonEvent(connection, 1, 1, 0)
            xtest.XTestFakeButtonEvent(connection, 1, 0, 0)
            x11.XSync(connection, 0)
            print("Clicked native Mute on X item")
            raise SystemExit(0)
    time.sleep(0.15)
raise SystemExit("Could not find Mute on X. Fixture display text: " + " ".join(row[-1] for row in words))
