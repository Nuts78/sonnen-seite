"""Sonnen-Seite: ein winziger Webserver, der nur die Sonnen-Laune-Seite ausliefert.

Er fragt ein paar fest eingestellte Entitäten bei Home Assistant ab (über die
Supervisor-API, der Token bleibt im Container) und gibt nach außen nur diese
Werte weiter. Es gibt keine Schalter, keinen Login und keinen Weg zu HA.
"""
import html
import json
import os
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_DIR = os.path.dirname(os.path.abspath(__file__))
OPTIONS_FILE = os.environ.get("OPTIONS_FILE", "/data/options.json")
HA_URL = os.environ.get("HA_URL", "http://supervisor/core/api")
TOKEN = os.environ.get("SUPERVISOR_TOKEN", "")
PORT = int(os.environ.get("PORT", "8099"))
CACHE_SECONDS = 5

ENTITY_KEYS = ["pv_entity", "soc_entity", "load_entity", "grid_entity", "relay_entity", "threshold_entity"]


def load_options():
    with open(OPTIONS_FILE, encoding="utf-8") as f:
        return json.load(f)


OPTIONS = load_options()
ENTITIES = [OPTIONS[k] for k in ENTITY_KEYS if OPTIONS.get(k)]

# Zusatzdaten: Wetter + PV-Prognose (mit Standardwerten, falls nicht konfiguriert)
EXTRA_DEFAULTS = {
    "weather_entity": "weather.forecast_home",
    "pv_today_entity": "sensor.deye_sunsynk_sol_ark_3_phase_x_2_pv_energy",
    # Helios-Prognose: Präfixe der Strings, kommagetrennt
    "helios_strings": "string_1_west_oben,string_2_ost_oben,string_3_west_unten,string_4_ost_unten",
}
EXTRA = {k: (OPTIONS.get(k) or v) for k, v in EXTRA_DEFAULTS.items()}
HELIOS = [x.strip() for x in EXTRA["helios_strings"].split(",") if x.strip()]


def helios_sum(suffix):
    vals = [_num(fetch_state(f"sensor.{p}_{suffix}")) for p in HELIOS]
    vals = [v for v in vals if v is not None]
    return round(sum(vals), 1) if vals else None
EXTRA_SECONDS = 300

# Nur das, was die Karte braucht – Entity-IDs werden durch neutrale Namen ersetzt.
CARD_CONFIG = {
    "title": "",
    "pv_max": OPTIONS.get("pv_max", 8000),
    "pv_sunny": OPTIONS.get("pv_sunny", 300),
}
for k in ENTITY_KEYS:
    if OPTIONS.get(k):
        CARD_CONFIG[k] = k  # neutraler Platzhalter statt echter Entity-ID


def read_file(name):
    with open(os.path.join(APP_DIR, name), "rb") as f:
        return f.read()


INDEX = read_file("index.html").replace(b"__TITLE__", OPTIONS.get("title", "Sonnenstrom").encode())
IMPRESSUM = (
    read_file("impressum.html")
    .replace(b"__TITLE__", html.escape(OPTIONS.get("title", "Sonnenstrom")).encode())
    .replace(b"__NAME__", html.escape(OPTIONS.get("impressum_name") or "Stefan Nussbaumer").encode())
    .replace(b"__ORT__", html.escape(OPTIONS.get("impressum_ort") or "5310 Tiefgraben, Österreich").encode())
)
CARD_JS = read_file("card.js")
ICON = read_file("icon.svg")
MANIFEST = json.dumps({
    "name": OPTIONS.get("title", "Sonnenstrom"),
    "short_name": OPTIONS.get("title", "Sonnenstrom"),
    "start_url": "/",
    "display": "standalone",
    "background_color": "#bfe6ff",
    "theme_color": "#ffc414",
    "icons": [{"src": "/icon.svg", "sizes": "any", "type": "image/svg+xml"}],
}).encode()

_cache = {"t": 0.0, "body": b"{}"}
_lock = threading.Lock()

# --- Zugriffszähler (nur Zahlen, keine IP-Adressen) ---
STATS_FILE = os.environ.get("STATS_FILE", "/data/stats.json")
_stats_lock = threading.Lock()


def _load_stats():
    try:
        with open(STATS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
        return {"total": 0, "day": "", "today": 0}


_stats = _load_stats()


def _today():
    return time.strftime("%Y-%m-%d", time.localtime())


def count_visit():
    with _stats_lock:
        d = _today()
        if _stats.get("day") != d:
            _stats["day"], _stats["today"] = d, 0
        _stats["total"] = _stats.get("total", 0) + 1
        _stats["today"] += 1
        try:
            tmp = STATS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(_stats, f)
            os.replace(tmp, STATS_FILE)
        except Exception as e:  # noqa: BLE001
            print(f"Zähler konnte nicht gespeichert werden: {e}", flush=True)


def visits():
    with _stats_lock:
        today = _stats.get("today", 0) if _stats.get("day") == _today() else 0
        return {"total": _stats.get("total", 0), "today": today}


def _ha(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{HA_URL}{path}", data=data, method="POST" if data else "GET",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=8) as r:
        return json.load(r)


def _num(v):
    try:
        return round(float(v), 1)
    except (TypeError, ValueError):
        return None


_extra = {"t": 0.0, "data": {}}


def get_extra():
    """Wetter und PV-Prognose – seltener abfragen (alle 5 Minuten)."""
    now = time.time()
    if now - _extra["t"] < EXTRA_SECONDS:
        return _extra["data"]
    out = {}
    try:
        w = _ha(f"/states/{EXTRA['weather_entity']}")
        a = w.get("attributes", {})
        weather = {
            "cond": w.get("state"),
            "temp": _num(a.get("temperature")),
            "wind": _num(a.get("wind_speed")),
            "humidity": _num(a.get("humidity")),
            "clouds": _num(a.get("cloud_coverage")),
            "daily": [],
        }
        try:
            r = _ha("/services/weather/get_forecasts?return_response",
                    {"entity_id": EXTRA["weather_entity"], "type": "daily"})
            fc = (r.get("service_response") or {}).get(EXTRA["weather_entity"], {}).get("forecast", [])
            weather["daily"] = [{
                "date": d.get("datetime"), "cond": d.get("condition"),
                "tmax": _num(d.get("temperature")), "tmin": _num(d.get("templow")),
                "rain": _num(d.get("precipitation")),
            } for d in fc[:6]]
        except Exception as e:  # noqa: BLE001
            print(f"Wettervorschau nicht lesbar: {e}", flush=True)
        out["weather"] = weather
    except Exception as e:  # noqa: BLE001
        print(f"Wetter nicht lesbar: {e}", flush=True)
    out["pv"] = {
        "today": _num(fetch_state(EXTRA["pv_today_entity"])),
        "remaining": helios_sum("energy_today_remaining"),
        "tomorrow": helios_sum("energy_day_1"),
        "day2": helios_sum("energy_day_2"),
        "source": "Helios",
    }
    _extra["data"], _extra["t"] = out, now
    return out


def fetch_state(entity_id):
    req = urllib.request.Request(
        f"{HA_URL}/states/{entity_id}",
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r).get("state", "unavailable")
    except Exception as e:  # noqa: BLE001
        print(f"Fehler beim Lesen von {entity_id}: {e}", flush=True)
        return "unavailable"


def get_data():
    with _lock:
        now = time.time()
        if now - _cache["t"] > CACHE_SECONDS:
            states = {}
            for k in ENTITY_KEYS:
                eid = OPTIONS.get(k)
                if eid:
                    states[k] = {"state": fetch_state(eid)}
            _cache["data"] = {"config": CARD_CONFIG, "states": states, "time": int(now), **get_extra()}
            _cache["t"] = now
        return json.dumps({**_cache["data"], "visits": visits()}).encode()


class Handler(BaseHTTPRequestHandler):
    server_version = "SonnenSeite"
    sys_version = ""

    def _send(self, code, body, ctype, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:",
        )
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            if self.command == "GET":
                count_visit()
            self._send(200, INDEX, "text/html; charset=utf-8")
        elif path in ("/impressum", "/impressum.html"):
            self._send(200, IMPRESSUM, "text/html; charset=utf-8")
        elif path == "/api/data":
            self._send(200, get_data(), "application/json")
        elif path == "/card.js":
            self._send(200, CARD_JS, "text/javascript; charset=utf-8", "max-age=300")
        elif path == "/icon.svg":
            self._send(200, ICON, "image/svg+xml", "max-age=86400")
        elif path == "/manifest.json":
            self._send(200, MANIFEST, "application/manifest+json", "max-age=86400")
        else:
            self._send(404, b"Nicht gefunden", "text/plain; charset=utf-8")

    def log_message(self, fmt, *args):
        pass  # keine Zugriffs-Logs


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # abgebrochene Verbindungen (Browser geschlossen) nicht loggen


if __name__ == "__main__":
    print(f"Sonnen-Seite läuft auf Port {PORT} mit {len(ENTITIES)} Entitäten", flush=True)
    Server(("0.0.0.0", PORT), Handler).serve_forever()
