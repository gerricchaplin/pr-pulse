#!/usr/bin/env python3
"""Fail when the plugin hooks an event or calls an API missing from capabilities.txt.

`claude plugin validate` lists every hook and every `$` call the module makes; a change to that
surface has to be reviewed and committed to capabilities.txt alongside the code.
"""
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
out = subprocess.run(["claude", "plugin", "validate", str(root)], capture_output=True, text=True).stdout


def items(kind: str) -> set[str]:
    match = re.search(rf"register\.tsx {kind}: (.+)", out)
    if not match:
        sys.exit(f"could not find the '{kind}' line in `claude plugin validate` output:\n{out}")
    # split on commas outside {...}, drop "(via helper)" notes
    parts = re.split(r",\s*(?![^{]*\})", re.sub(r" \(via [^)]*\)", "", match.group(1)))
    return {f"{kind[:-1] if kind == 'hooks' else 'call'} {p.strip()}" for p in parts if p.strip()}


actual = items("hooks") | items("calls")
expected = {line.strip() for line in (root / "capabilities.txt").read_text().splitlines() if line.strip() and not line.startswith("#")}

added, removed = sorted(actual - expected), sorted(expected - actual)
for line in added:
    print(f"+ {line}   (new capability: review it, then add it to capabilities.txt)")
for line in removed:
    print(f"- {line}   (no longer used: remove it from capabilities.txt)")
if added or removed:
    sys.exit(1)
print(f"capabilities unchanged ({len(actual)} entries)")
