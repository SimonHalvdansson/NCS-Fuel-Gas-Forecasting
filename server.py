#!/usr/bin/env python3
"""Build and serve the static GitHub Pages bundle locally."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from scripts.build_pages import SITE, main as build_pages


class StaticFileHandler(SimpleHTTPRequestHandler):
    """Serve static files without exposing directory listings."""

    def list_directory(self, path: str):
        self.send_error(404, "File not found")
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1", help="address to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="port to serve (default: 8765)")
    args = parser.parse_args()

    build_pages()
    handler = partial(StaticFileHandler, directory=str(SITE))
    with ThreadingHTTPServer((args.bind, args.port), handler) as server:
        print(f"Serving the forecast web app at http://{args.bind}:{args.port}/")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
