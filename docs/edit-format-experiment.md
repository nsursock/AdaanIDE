# Edit-Format Experiment (Phase B)

## Goal

Settle the disagreement between architecture reviews on the best edit format
for weak (sub-5B) models: `apply_patch` (SEARCH/REPLACE) vs full-file rewrite
(`write_file`) vs directed patch (explicit format instruction).

## Design

Three variants of the **same** edit task — a 50-line Python `calculator.py`
with a bug in `divide()` (returns `a * b` instead of `a / b`). All three
share the same `verify()`: the bug must be fixed AND all other functions
must remain intact (so truncated rewrites fail).

| Variant | Toolset | Prompt instruction |
|---|---|---|
| `edit-format-patch` | full (apply_patch available) | "Use apply_patch to make the fix" |
| `edit-format-rewrite` | apply_patch excluded | "Use write_file to rewrite the entire file" |
| `edit-format-directed-patch` | full | Explicit SEARCH/REPLACE format instructions |

## How to run

```bash
# 1. Start the local model server
rapid-mlx serve qwen2.5-coder-3b-instruct  # or any 4B model

# 2. Set the endpoint in Settings → Models → Endpoint base URL
#    http://localhost:8000/v1

# 3. Run the experiment via the API (3+ runs per variant)
for variant in edit-format-patch edit-format-rewrite edit-format-directed-patch; do
  for run in 1 2 3; do
    curl -X POST http://localhost:5174/api/benchmark/run \
      -H "Content-Type: application/json" \
      -d "{\"tasks\": [\"$variant\"], \"models\": [\"qwen2.5-coder-3b-instruct\"]}" \
      --no-buffer
  done
done

# 4. Check results
curl http://localhost:5174/api/benchmark/results | jq '.[] | select(.taskId | startswith("edit-format"))'
```

## Results

> **NOTE**: This table must be filled with real measured numbers from the
> local 4B model. Do NOT fabricate data. Run ≥3 runs per variant.

| Variant | Model | Runs | Success rate | Avg requests/task | Avg output tokens | Failure mode |
|---|---|---|---|---|---|---|
| edit-format-patch | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| edit-format-rewrite | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
| edit-format-directed-patch | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## Decision rule

- If `edit-format-patch` success rate ≥ 60%: default Phase C to `apply_patch`.
- If `edit-format-rewrite` success rate > `edit-format-patch` by ≥15pp:
  default Phase C to `write_file` (full rewrite).
- If `edit-format-directed-patch` success rate > `edit-format-patch` by ≥10pp:
  add explicit format instructions to the system prompt for weak models.
- If all variants < 40%: the edit format isn't the bottleneck — investigate
  other failure modes (context, tool selection, iteration cap).
