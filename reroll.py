import subprocess
import time
import re

cf_exe = r"C:\Users\longm\AppData\Local\hermes\bin\cloudflared.exe"
log_path = r"C:\Users\longm\archery-league\tunnel.log"

CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000
creationflags = CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW

for attempt in range(1, 15):
    # Kill any existing cloudflared
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
    
    # Wait for URL to appear in log
    found_url = None
    for _ in range(8):
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
        print(f"[{attempt}] {sub} -> {found_url}")
        # Check if words are nice, short, or clean
        words = sub.split('-')
        bad_words = ['africa', 'promised', 'comparing', 'diseases', 'crime', 'murder', 'debt']
        if not any(bw in sub.lower() for bw in bad_words) and len(words) <= 4:
            print(f"SELECTED: {found_url}")
            break
