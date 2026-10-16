import http.server
import socketserver
from urllib.parse import urlparse

PORT = 8899


class SmartCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 必须先剥掉查询串（如 ?v=r2）再判断扩展名：
        # 否则 "/app.js?v=r2" 不以 .js 结尾，会被误判成大体积二进制而强缓存一年
        path = urlparse(self.path).path.lower()
        # 源码类文件（含 .js，逻辑改动频繁）一律禁用缓存；
        # 大体积二进制资源（wasm/onnx/bin 等）保持强缓存，避免重复下载。
        # 根路径 "/" 实际返回 index.html，也必须禁用缓存，否则首页会被缓存一年
        if path in ('', '/') or path.endswith(('.html', '.css', '.js', '.mjs', '.json', '.map', '.svg')):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        else:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        super().end_headers()

    def log_message(self, format, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), SmartCacheHandler) as httpd:
    print(f"Serving at http://127.0.0.1:{PORT}")
    httpd.serve_forever()
