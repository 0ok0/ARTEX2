#!/usr/bin/env bash
# fetch_finding.sh <finding_id> — 从 ARTEX2 库拉漏洞材料，输出到 stdout（JSON）
# 用法: PGPASSWORD=... ./fetch_finding.sh 58
set -euo pipefail

FID="${1:?用法: fetch_finding.sh <finding_id>}"
export PGPASSWORD="${PGPASSWORD:-artex_dev_2026}"

psql -h "${ARTEX_DB_HOST:-127.0.0.1}" -U "${ARTEX_DB_USER:-artex}" -d "${ARTEX_DB_NAME:-artex}" -tAc "
select json_build_object(
  'id',            f.id,
  'task_id',       f.task_id,
  'vulnclass',     f.vulnclass,
  'name',          f.name,
  'severity',      f.severity,
  'summary',       f.summary,
  'evidence',      f.evidence,
  'report',        f.report,
  'status',        f.status
)::text
from findings f where f.id = ${FID};"
