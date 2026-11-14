#!/usr/bin/env python3
"""Build presets.json from presets_spec.json plus the gateway's epoch registry.

The registry (CACHE_DIR/epochs.jsonl) maps every epoch id the gateway has seen
to its IBE access URL. Embedding those URLs lets preset ids work on a fresh
server before any SIA query. Usage:
    python3 gateway/presets/build_presets.py [CACHE_DIR]
"""
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
cache = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, "..", "..", ".cache")
reg = {}
with open(os.path.join(cache, "epochs.jsonl")) as fh:
    for line in fh:
        r = json.loads(line)
        reg[r["id"]] = r

spec = json.load(open(os.path.join(here, "presets_spec.json")))
keep = ["id", "obs_id", "det", "band", "mjd", "date", "exptime", "em_min_um", "em_max_um", "collection", "url"]
for p in spec["presets"]:
    ids = list(p.get("epochs", [])) + [f["id"] for f in p.get("frames", [])]
    srcs = []
    for i in dict.fromkeys(ids):
        if i not in reg:
            sys.exit(f"preset {p['id']}: epoch {i} not in registry; run /api/epochs there first")
        srcs.append({k: reg[i][k] for k in keep if k in reg[i]})
    p["sources"] = srcs
json.dump(spec, open(os.path.join(here, "presets.json"), "w"), indent=1, ensure_ascii=False)
print("wrote", len(spec["presets"]), "presets")
