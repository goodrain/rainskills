#!/usr/bin/env python3

import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse


result_path = sys.argv[1]
expected_state = sys.argv[2]
timeout = int(sys.argv[3])

received = {"token": None, "error": None}

SUCCESS_HTML = (
    '<!doctype html><meta charset="utf-8">'
    "<title>Rainbond CLI 授权完成</title>"
    '<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;'
    'max-width:480px;margin:120px auto;text-align:center;color:#1f2933;">'
    '<h2 style="color:#0a7d3a;">授权完成</h2>'
    "<p>Rainbond CLI 已收到凭证，请回到终端继续。可以关闭此页面。</p>"
    "</body>"
)
ERROR_HTML = (
    '<!doctype html><meta charset="utf-8">'
    "<title>Rainbond CLI 授权失败</title>"
    '<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;'
    'max-width:480px;margin:120px auto;text-align:center;color:#1f2933;">'
    '<h2 style="color:#b8312f;">授权失败</h2>'
    "<p>{detail}</p><p>请回到终端重新执行 install.sh。</p></body>"
)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin") or "*"
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS, GET")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        if self.headers.get("Access-Control-Request-Private-Network", "").lower() == "true":
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def log_message(self, fmt, *args):
        return

    def _finish(self, status, message):
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(message.encode("utf-8"))

    def _handle_callback(self, params):
        state = (params.get("state") or [None])[0]
        token = (params.get("token") or [None])[0]
        if state != expected_state:
            received["error"] = "Rainbond 浏览器授权回调 state 不匹配，疑似 CSRF。"
            self._finish(400, ERROR_HTML.format(detail="state 校验失败"))
            return
        if not token:
            received["error"] = "Rainbond 浏览器授权回调缺少 token。"
            self._finish(400, ERROR_HTML.format(detail="缺少 token"))
            return
        received["token"] = token
        self._finish(200, SUCCESS_HTML)

    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/cli-callback"):
            self._finish(404, "not found")
            return
        self._handle_callback(parse_qs(parsed.query))

    def do_POST(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/cli-callback"):
            self._finish(404, "not found")
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as exc:
            received["error"] = "回调载荷不是合法 JSON：{}".format(exc)
            self._finish(400, ERROR_HTML.format(detail="无效请求"))
            return
        params = {key: [value] for key, value in payload.items() if value is not None}
        self._handle_callback(params)


server = HTTPServer(("127.0.0.1", 0), Handler)
print(server.server_address[1], flush=True)

deadline = time.time() + timeout
server.timeout = 1.0
while time.time() < deadline and received["token"] is None and received["error"] is None:
    server.handle_request()

if received["error"]:
    print(received["error"], file=sys.stderr)
    sys.exit(2)
if received["token"] is None:
    print("Rainbond 浏览器授权超时（{} 秒）。".format(timeout), file=sys.stderr)
    sys.exit(3)

with open(result_path, "w", encoding="utf-8") as result_file:
    result_file.write(received["token"])
