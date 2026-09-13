#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
config_path="${DISPATCH_WORKER_CONFIG:-$script_dir/worker.disabled.json}"
export DISPATCH_WORKER_CONFIG_DEFAULT="$config_path"

exec python3 -B - "$@" <<'PY'
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


parser = argparse.ArgumentParser()
parser.add_argument(
    "--config",
    default=os.environ["DISPATCH_WORKER_CONFIG_DEFAULT"],
)
parser.add_argument("--once", action="store_true")
parser.add_argument("--loop", action="store_true")
args = parser.parse_args()

if args.once and args.loop:
    fail("--once and --loop are mutually exclusive")

with open(args.config, "r", encoding="utf-8") as source:
    config = json.load(source)

if config.get("enabled") is not True:
    print("dispatch worker disabled")
    sys.exit(0)

base_url = str(config.get("endpoint_url") or "").rstrip("?&")
if not base_url:
    fail("dispatch worker endpoint_url is required when enabled")

token_env = str(config.get("token_env") or "DISPATCH_WORKER_TOKEN")
token = os.environ.get(token_env)
if not token:
    fail(f"{token_env} is required when dispatch worker is enabled")

interval = config.get("interval_seconds")
if args.loop:
    if not isinstance(interval, (int, float)) or interval <= 0:
        fail("interval_seconds must be positive for --loop")
else:
    args.once = True

timeout = float(config.get("timeout_seconds") or 30)
headers = {
    "authorization": f"Bearer {token}",
    "content-type": "application/json",
}


def post(action, body):
    separator = "&" if "?" in base_url else "?"
    request = urllib.request.Request(
        f"{base_url}{separator}action={action}",
        data=json.dumps(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")
        fail(f"{action} failed with HTTP {error.code}: {detail}")
    except urllib.error.URLError as error:
        fail(f"{action} failed: {error.reason}")
    try:
        return json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError:
        fail(f"{action} returned invalid JSON")


def cycle():
    trigger = post("dispatch_trigger", config.get("trigger_body") or {})
    run = post("dispatch_run", config.get("run_body") or {})
    refresh = post("dispatch_refresh_worker", {})
    print(json.dumps({
        "dispatch_worker": "cycle_complete",
        "dispatch_trigger": trigger,
        "dispatch_run": run,
        "dispatch_refresh": refresh,
    }, separators=(",", ":")))


while True:
    cycle()
    if args.once:
        break
    time.sleep(float(interval))
PY
