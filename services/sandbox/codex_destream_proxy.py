"""De-streaming shim for the OpenAI Responses dialect (codex harness).

The deployment's provider drops trailing output blocks on the STREAMING
responses path: a request whose complete (non-streamed) response is
`message + function_call` streams back as `message` only — the model
announces its plan and the tool call it intended to make is silently
dropped, so the turn ends with no action (or, in the extreme, zero output
items despite billed output tokens). Non-streamed responses are complete —
verified live: 6/6 stream:true drop the function_call, 6/6 stream:false keep
it.

codex's app-server always streams, so this shim accepts its
`POST /v1/responses` (and any other path, passed through untouched),
forwards the request NON-streamed to the real upstream, and synthesizes the
Responses SSE event sequence from the complete response object. Enabled by
CODEX_DESTREAM_PROXY=1; the entrypoint points model_providers.*.base_url at
it. Remove when the provider's streaming path is fixed.

Symmetric to claude_destream_proxy.py (Anthropic messages dialect).
"""
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# codex's base_url already carries the API path (e.g. .../v1) and it appends
# /responses, so the inbound self.path is the FULL path (/v1/responses). Forward
# against the upstream ORIGIN only (scheme://host) to avoid doubling the path.
from urllib.parse import urlsplit
_raw_upstream = os.environ.get("DESTREAM_UPSTREAM", "https://api.unbiased.ai")
_parts = urlsplit(_raw_upstream)
UPSTREAM = f"{_parts.scheme}://{_parts.netloc}"
PORT = int(os.environ.get("DESTREAM_PORT", "8378"))
HOP = {"host", "content-length", "connection", "accept-encoding", "transfer-encoding"}


def sse(obj):
    return f"event: {obj['type']}\ndata: {json.dumps(obj)}\n\n".encode()


def synthesize(obj):
    """Build the Responses SSE stream from a complete response object."""
    seq = 0

    def ev(payload):
        nonlocal seq
        payload["sequence_number"] = seq
        seq += 1
        return sse(payload)

    out = []
    output = obj.get("output", []) or []
    # response.created / .in_progress carry the response shell with empty output.
    shell = {k: v for k, v in obj.items() if k != "output"}
    shell_inprogress = dict(shell, status="in_progress", output=[])
    out.append(ev({"type": "response.created", "response": shell_inprogress}))
    out.append(ev({"type": "response.in_progress", "response": shell_inprogress}))

    for i, item in enumerate(output):
        itype = item.get("type")
        if itype == "message":
            started = dict(item, status="in_progress", content=[])
            out.append(ev({"type": "response.output_item.added", "output_index": i,
                           "item": started}))
            for ci, part in enumerate(item.get("content", []) or []):
                if part.get("type") in ("output_text", "text"):
                    text = part.get("text", "")
                    out.append(ev({"type": "response.content_part.added", "item_id": item.get("id"),
                                   "output_index": i, "content_index": ci,
                                   "part": {"type": "output_text", "text": "",
                                            "annotations": part.get("annotations", [])}}))
                    if text:
                        out.append(ev({"type": "response.output_text.delta", "item_id": item.get("id"),
                                       "output_index": i, "content_index": ci, "delta": text}))
                    out.append(ev({"type": "response.output_text.done", "item_id": item.get("id"),
                                   "output_index": i, "content_index": ci, "text": text}))
                    out.append(ev({"type": "response.content_part.done", "item_id": item.get("id"),
                                   "output_index": i, "content_index": ci, "part": part}))
                else:
                    # Non-text part (e.g. reasoning/refusal): announce it whole.
                    out.append(ev({"type": "response.content_part.added", "item_id": item.get("id"),
                                   "output_index": i, "content_index": ci, "part": part}))
                    out.append(ev({"type": "response.content_part.done", "item_id": item.get("id"),
                                   "output_index": i, "content_index": ci, "part": part}))
            out.append(ev({"type": "response.output_item.done", "output_index": i, "item": item}))
        elif itype == "function_call":
            started = dict(item, status="in_progress", arguments="")
            out.append(ev({"type": "response.output_item.added", "output_index": i,
                           "item": started}))
            args = item.get("arguments", "")
            if not isinstance(args, str):
                args = json.dumps(args)
            if args:
                out.append(ev({"type": "response.function_call_arguments.delta",
                               "item_id": item.get("id"), "output_index": i, "delta": args}))
            out.append(ev({"type": "response.function_call_arguments.done",
                           "item_id": item.get("id"), "output_index": i, "arguments": args}))
            out.append(ev({"type": "response.output_item.done", "output_index": i, "item": item}))
        else:
            # Unknown item type: emit added+done whole so nothing is lost.
            out.append(ev({"type": "response.output_item.added", "output_index": i, "item": item}))
            out.append(ev({"type": "response.output_item.done", "output_index": i, "item": item}))

    out.append(ev({"type": "response.completed", "response": obj}))
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
        if "/responses" in self.path:
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
            resp = urllib.request.urlopen(req, timeout=1800)
            code, data, ctype = resp.getcode(), resp.read(), resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as e:
            self._respond(e.code, e.headers.get("Content-Type", "application/json"), e.read())
            return
        except Exception as e:
            self._respond(502, "application/json",
                          json.dumps({"error": {"type": "api_error",
                                      "message": f"codex destream shim upstream failure: {e}"}}).encode())
            return
        if destream and code == 200:
            try:
                self._respond(200, "text/event-stream", synthesize(json.loads(data)))
                return
            except (ValueError, KeyError):
                pass
        self._respond(code, ctype, data)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
