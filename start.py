# -*- coding: utf-8 -*-
"""研学台 · 一键启动。

双击本文件即可：起服务 → 开浏览器。
"""
import http.client
import os
import subprocess
import sys
import time
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable

print("研学台 · 启动中…")
proc = subprocess.Popen([PY, "-m", "server.main"], cwd=HERE)

url = "http://127.0.0.1:8770"
for i in range(40):
    time.sleep(0.5)
    try:
        c = http.client.HTTPConnection("127.0.0.1", 8770, timeout=1)
        c.request("GET", "/api/health")
        r = c.getresponse()
        if r.status == 200:
            print("已就绪 →", url)
            webbrowser.open(url)
            break
        c.close()
    except Exception:
        pass
else:
    print("服务没起来，看上面的报错。")

print("按 Ctrl+C 退出。")
try:
    proc.wait()
except KeyboardInterrupt:
    proc.terminate()
    print("\n已退出。")
