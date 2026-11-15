# Run on the VM: silhouette and purity/cohesion per k for a dataset (diagnoses the VM's k choice).
# Set TIDY_VM_SERVICE_DIR to the folder holding tidy_service.py (default: ~/tidy-tabs-llm/v2).
import json, os, sys
sys.path.insert(0, os.path.expanduser(os.environ.get("TIDY_VM_SERVICE_DIR", "~/tidy-tabs-llm/v2")))
import tidy_service as ts
ds = json.load(open(sys.argv[1])); tabs, exp = ds["tabs"], ds["expected"]
r = ts.post("/api/embed", {"model": "embeddinggemma", "truncate": True,
            "input": [ts.CFG["prefix"] + ts.text_of(t, ts.CFG["title_n"]) for t in tabs]})
X = [ts.normalize(v) for v in r["embeddings"]]
S = ts.similarity(X, [None] * len(X), 0.0)
cuts = ts.linkage_cuts(S, 12)
for k in sorted(cuts):
    lab = cuts[k]
    if k < 2: continue
    groups = {}
    for i, c in enumerate(lab): groups.setdefault(c, []).append(i)
    pure = tot = 0; by = {}
    for g, idx in groups.items():
        ts_ = [exp[str(tabs[i]["id"])] for i in idx if exp[str(tabs[i]["id"])] != "stray"]
        tot += len(ts_); pure += max([ts_.count(t) for t in set(ts_)] or [0])
        for t in ts_: by.setdefault(t, {}).setdefault(g, 0); by[t][g] += 1
    coh = sum(max(v.values()) for v in by.values()) / sum(sum(v.values()) for v in by.values())
    sizes = sorted((len(v) for v in groups.values()), reverse=True)
    print(f"k={k:2d} sil={ts.silhouette(S, lab):.3f} purity={pure/tot:.2f} cohesion={coh:.2f} sizes={sizes}")
