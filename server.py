import http.server
import socketserver

PORT = 8899


class SmartCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        path = self.path.lower()
        if path.endswith(('.html', '.css')):
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
