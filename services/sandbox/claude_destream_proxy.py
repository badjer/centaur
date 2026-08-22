"""De-streaming shim for the Anthropic messages dialect.

The upstream provider loses streamed content (empty messages, tokens still
billed) while non-streamed responses are complete. Claude Code always streams,
so this shim accepts its SSE request on localhost, forwards it NON-streamed to
the real upstream, and synthesizes the SSE event stream from the complete
response. Remove when the provider's streaming path is fixed.
"""
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("DESTREAM_UPSTREAM", "https://api.unbiased.ai")
PORT = int(os.environ.get("DESTREAM_PORT", "8377"))
HOP = {"host", "content-length", "connection", "accept-encoding", "transfer-encoding"}


def sse(event, obj):
    return f"event: {event}\ndata: {json.dumps(obj)}\n\n".encode()


def synthesize(message):
    out = []
    content = message.pop("content", []) or []
    usage = message.get("usage", {}) or {}
    stop_reason = message.pop("stop_reason", None)
    stop_sequence = message.pop("stop_sequence", None)
    start_msg = dict(message, content=[], stop_reason=None, stop_sequence=None,
                     usage={"input_tokens": usage.get("input_tokens", 0), "output_tokens": 0})
    out.append(sse("message_start", {"type": "message_start", "message": start_msg}))
    for i, block in enumerate(content):
        btype = block.get("type")
        if btype == "text":
            out.append(sse("content_block_start", {"type": "content_block_start", "index": i,
                                                     "content_block": {"type": "text", "text": ""}}))
            out.append(sse("content_block_delta", {"type": "content_block_delta", "index": i,
                                                     "delta": {"type": "text_delta", "text": block.get("text", "")}}))
        elif btype == "tool_use":
            out.append(sse("content_block_start", {"type": "content_block_start", "index": i,
                                                     "content_block": {"type": "tool_use", "id": block.get("id"),
                                                                        "name": block.get("name"), "input": {}}}))
            out.append(sse("content_block_delta", {"type": "content_block_delta", "index": i,
                                                     "delta": {"type": "input_json_delta",
                                                               "partial_json": json.dumps(block.get("input", {}))}}))
        elif btype == "thinking":
            out.append(sse("content_block_start", {"type": "content_block_start", "index": i,
                                                     "content_block": {"type": "thinking", "thinking": ""}}))
            out.append(sse("content_block_delta", {"type": "content_block_delta", "index": i,
                                                     "delta": {"type": "thinking_delta",
                                                               "thinking": block.get("thinking", "")}}))
            if block.get("signature"):
                out.append(sse("content_block_delta", {"type": "content_block_delta", "index": i,
                                                         "delta": {"type": "signature_delta",
                                                                   "signature": block["signature"]}}))
        else:
            # Unknown block type: emit fully-formed start so nothing is lost.
            out.append(sse("content_block_start", {"type": "content_block_start", "index": i,
                                                     "content_block": block}))
        out.append(sse("content_block_stop", {"type": "content_block_stop", "index": i}))
    out.append(sse("message_delta", {"type": "message_delta",
                                      "delta": {"type": "message_delta", "stop_reason": stop_reason,
                                                "stop_sequence": stop_sequence},
                                      "usage": usage}))
    out.append(sse("message_stop", {"type": "message_stop"}))
    return b"".join(out)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _respond(self, code, ctype, data):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP}
        destream = False
        if self.path.startswith("/v1/messages") and "count_tokens" not in self.path:
            try:
                parsed = json.loads(body)
                if parsed.get("stream") is True:
                    parsed["stream"] = False
                    body = json.dumps(parsed).encode()
                    destream = True
            except (ValueError, AttributeError):
                pass
        req = urllib.request.Request(UPSTREAM + self.path, data=body, headers=headers)
        try:
            resp = urllib.request.urlopen(req, timeout=1200)
            code, data, ctype = resp.getcode(), resp.read(), resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            self._respond(e.code, e.headers.get("Content-Type", "application/json"), e.read())
            return
        except Exception as e:
            self._respond(502, "application/json",
                          json.dumps({"type": "error", "error": {"type": "api_error",
                                      "message": f"destream shim upstream failure: {e}"}}).encode())
            return
        if destream and code == 200:
            try:
                self._respond(200, "text/event-stream", synthesize(json.loads(data)))
                return
            except (ValueError, KeyError) as e:
                pass
        self._respond(code, ctype, data)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
