# Kinetica Diagnostic Report

| Field                             | Value                   |
| --------------------------------- | ----------------------- |
| **Investigation Date/Time (UTC)** | YYYY-MM-DD HH:MM:SS UTC |
| **Kinetica Version**              | X.Y.Z.W                 |
| **Investigation Duration**        | N minutes               |
| **Tool Calls**                    | N                       |
| **Rounds**                        | N                       |

---

## Summary

[1-3 sentence executive summary. State whether the issue was identified and what it is.]

---

## Remediation

[Numbered list of specific, actionable remediation steps tied to the identified root cause. Include both immediate manual actions and agent-assisted mutation steps.]

---

## Root Cause Analysis

[Named root cause with supporting evidence. Commit to the most likely cause. If multiple hypotheses, rank by likelihood. No generic hedging.]

---

## Evidence Collected

[Key findings only — NOT raw tool response dumps. Extract the relevant data points that support your conclusion. Reference which tool provided each finding.]

---

## Evidence Gaps

[Any tool calls that failed or returned incomplete data. Include HTTP status codes where available, e.g., "Cluster status: unavailable (HTTP 503)". Write "None" if all tools responded successfully.]

---

## Mutations Applied

| Timestamp | Tool      | Parameters  | Before | After | Approval        | Verified             |
| --------- | --------- | ----------- | ------ | ----- | --------------- | -------------------- |
| HH:MM:SS  | tool_name | param=value | old    | new   | APPROVED/DENIED | confirmed/failed/N/A |

Write "None" if no mutations were proposed during this investigation.

---

## Post-Remediation Verification

[Summary of Round 5 re-check results. What was confirmed changed. What still shows warning.
Include specific metric comparisons: "GPU memory reduced from 95% to 78%".
Write "Not applicable -- no mutations applied" if no mutations were approved.]
