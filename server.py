import http.server
import socketserver

PORT = 8899


class SmartCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.lower()
        # 源码类文件（含 .js，Tab 逻辑改动的重灾区）一律禁用缓存；
        # 大体积二进制资源（wasm/onnx/bin 等）保持强缓存，避免重复下载。
        if path.endswith(('.html', '.css', '.js', '.mjs', '.json', '.map')):
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
