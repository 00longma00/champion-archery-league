import subprocess
import time

CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000
creationflags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

cf_exe = r"C:\Users\longm\AppData\Local\hermes\bin\cloudflared.exe"
log_path = r"C:\Users\longm\archery-league\tunnel.log"

with open(log_path, "w", encoding="utf-8") as out:
    proc = subprocess.Popen(
        [cf_exe, "tunnel", "--url", "http://127.0.0.1:3456"],
        cwd=r"C:\Users\longm\archery-league",
        stdout=out,
        stderr=out,
        creationflags=creationflags
    )
    print(f"TUNNEL SPAWNED PID={proc.pid}")
