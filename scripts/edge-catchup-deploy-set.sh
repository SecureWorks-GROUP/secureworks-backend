#!/usr/bin/env bash
# ONE-OFF (Oct 2026 catch-up deploy). Removed by the follow-up MR once the
# catch-up deploy is proven. Do not build on it.
#
# Prints the edge functions whose source on HEAD differs from any of the given
# base commits, including every function that imports (directly or through
# other _shared files) a changed supabase/functions/_shared file.
#
# Why several bases: production edge code came from two lanes. The GitHub
# runner deployed GitHub main (last at 3e90cc81, 1 Oct 2026), and GitLab
# deployed GitLab main until its CLI install broke after 9282ad51. A function
# is stale if HEAD differs from whichever lane deployed it last, so the safe
# set is the union over both bases.
#
# Usage: scripts/edge-catchup-deploy-set.sh <base-sha> [<base-sha>...]
# Output: one line, space-separated function names, sorted.

set -euo pipefail

[[ $# -ge 1 ]] || { echo "usage: $0 <base-sha> [<base-sha>...]" >&2; exit 2; }

HEAD_COMMIT="$(git rev-parse --verify 'HEAD^{commit}')"
changed_files="$(mktemp)"
trap 'rm -f "$changed_files"' EXIT

for base in "$@"; do
  base_commit="$(git rev-parse --verify "${base}^{commit}" 2>/dev/null)" ||
    { echo "FAIL base is not a valid commit: $base" >&2; exit 1; }
  git diff --name-only "$base_commit" "$HEAD_COMMIT" -- supabase/functions >> "$changed_files"
done

CHANGED_FILES="$changed_files" python3 - <<'PY'
import os, re, sys
from pathlib import Path

root = Path("supabase/functions")
changed = {line.strip() for line in open(os.environ["CHANGED_FILES"]) if line.strip()}

functions = set()
shared_changed = set()
for path in changed:
    parts = path.split("/")
    if len(parts) < 4:
        continue  # top-level files such as supabase/functions/README.md
    if parts[2] == "_shared":
        shared_changed.add(path)
    else:
        functions.add(parts[2])  # same rule as identify-edge-deploy-changes.sh

# Relative static and dynamic imports/exports. _shared consumers always use
# relative specifiers ("../_shared/x.ts"), so remote specifiers are skipped.
spec_re = re.compile(r"""(?:from|import)\s*\(?\s*['"](\.{1,2}/[^'"]+)['"]""")

def local_imports(path):
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return set()
    return {os.path.normpath(os.path.join(os.path.dirname(path), s)) for s in spec_re.findall(text)}

# A function also needs a deploy when the module graph its index.ts bundles
# reaches a changed _shared file (tests and unimported files do not count).
if shared_changed:
    for entry in sorted(root.glob("*/index.ts")):
        name = entry.parent.name
        if name == "_shared" or name in functions:
            continue
        seen, stack = set(), [str(entry)]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            stack.extend(local_imports(cur) - seen)
        hit = sorted(seen & shared_changed)
        if hit:
            functions.add(name)
            print(f"note: {name} bundles changed _shared file(s): {' '.join(hit)}", file=sys.stderr)

# Only directories that still exist on HEAD and carry an entrypoint deploy.
deployable = sorted(f for f in functions if (root / f / "index.ts").is_file())
missing = sorted(f for f in functions if f not in deployable)
for name in missing:
    print(f"note: {name} changed but has no index.ts on HEAD; not deployable", file=sys.stderr)
print(" ".join(deployable))
PY
