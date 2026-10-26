import subprocess
import time
import re

cf_exe = r"C:\Users\longm\AppData\Local\hermes\bin\cloudflared.exe"
log_path = r"C:\Users\longm\archery-league\tunnel.log"

CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000
creationflags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

history = []

for attempt in range(1, 10):
    subprocess.run(["taskkill", "-F", "-IM", "cloudflared.exe"], capture_output=True)
    time.sleep(1)
    
    with open(log_path, "w", encoding="utf-8") as out:
        proc = subprocess.Popen(
            [cf_exe, "tunnel", "--url", "http://127.0.0.1:3456"],
            cwd=r"C:\Users\longm\archery-league",
            stdout=out,
            stderr=out,
            creationflags=creationflags
        )
    
    found_url = None
    sub = ""
    for _ in range(7):
        time.sleep(1)
        try:
            with open(log_path, "r", encoding="utf-8") as f:
                content = f.read()
                m = re.search(r"https://([a-zA-Z0-9-]+)\.trycloudflare\.com", content)
                if m:
                    found_url = m.group(0)
                    sub = m.group(1)
                    break
        except Exception:
            pass
            
    if found_url:
        print(f"Option {attempt}: {sub}  -->  {found_url}")
        history.append((sub, found_url))
        # If it has nice short sports/clean words
        sports = ['archery', 'bow', 'arrow', 'aim', 'target', 'league', 'sunday', 'team', 'club', 'pro', 'fit', 'run', 'gold', 'hit']
        if any(w in sub.lower() for w in sports):
            print(f"GREAT MATCH FOUND: {found_url}")
            break
        if attempt >= 5:
            break
