import subprocess
import sys
import os

CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000
creationflags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

log_path = r"C:\Users\longm\archery-league\server.log"
with open(log_path, "w", encoding="utf-8") as out:
    proc = subprocess.Popen(
        [r"C:\Users\longm\AppData\Local\hermes\tools\node-26.7.0-win32-x64\node.exe", "server.js"],
        cwd=r"C:\Users\longm\archery-league",
        stdout=out,
        stderr=out,
        creationflags=creationflags
    )
    print(f"SPAWNED PID={proc.pid}")
