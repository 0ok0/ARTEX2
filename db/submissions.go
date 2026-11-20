package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

// src_* / finding_submissions 的数据访问层。语义见 schema.sql 末尾的说明：
// 表单在生成时冻结，状态机由 server 侧白名单校验，这里只做存储。

// SrcVendor is one 厂商档案.
type SrcVendor struct {
	ID         int64     `json:"id"`
	Platform   string    `json:"platform"`
	Name       string    `json:"name"`
	Domain     string    `json:"domain"`
	RootDomain string    `json:"root_domain"`
	Scope      []string  `json:"scope"`
	Industry   string    `json:"industry"`
	Region     string    `json:"region"`
	WeightZero bool      `json:"weight_zero"`
	Contact    string    `json:"contact"`
	Enabled    bool      `json:"enabled"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Submission states (finding_submissions.state).
const (
	SubmissionDraft      = "draft"      // 预审未过
	SubmissionReady      = "ready"      // 材料就绪，待提交
	SubmissionSubmitting = "submitting" // 浏览器填表中
	SubmissionSubmitted  = "submitted"  // 已提交，待审核
	SubmissionAccepted   = "accepted"   // 平台通过
	SubmissionRejected   = "rejected"   // 平台驳回
	SubmissionDuplicate  = "duplicate"  // 平台判重复
	SubmissionWithdrawn  = "withdrawn"  // 主动撤回
	SubmissionSuperseded = "superseded" // 被新版本替代
)

// ValidSubmissionState reports whether s is a known state.
func ValidSubmissionState(s string) bool {
	switch s {
	case SubmissionDraft, SubmissionReady, SubmissionSubmitting, SubmissionSubmitted,
		SubmissionAccepted, SubmissionRejected, SubmissionDuplicate, SubmissionWithdrawn,
		SubmissionSuperseded:
		return true
	}
	return false
}

// OpenSubmissionStates are the states that occupy the "one open submission per
// finding×platform×vendor" unique index.
func OpenSubmissionState(s string) bool {
	switch s {
	case SubmissionDraft, SubmissionReady, SubmissionSubmitting, SubmissionSubmitted:
		return true
	}
	return false
}

// SubmissionMaterial is one generated file.
type SubmissionMaterial struct {
	Name   string `json:"name"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// FindingSubmission is one row of finding_submissions.
type FindingSubmission struct {
	ID          int64                `json:"id"`
	FindingID   int64                `json:"finding_id"`
	VendorID    *int64               `json:"vendor_id,omitempty"`
	Platform    string               `json:"platform"`
	State       string               `json:"state"`
	ExternalID  string               `json:"external_id"`
	Form        map[string]string    `json:"form"`
	Materials   []SubmissionMaterial `json:"materials"`
	Blockers    []map[string]any     `json:"blockers"`
	Warnings    []map[string]any     `json:"warnings"`
	Note        string               `json:"note"`
	SubmittedAt *time.Time           `json:"submitted_at,omitempty"`
	ReviewedAt  *time.Time           `json:"reviewed_at,omitempty"`
	CreatedAt   time.Time            `json:"created_at"`
	UpdatedAt   time.Time            `json:"updated_at"`
	// VendorName is filled by the list/get queries for convenience.
	VendorName string `json:"vendor_name,omitempty"`
	// FindingTitle / FindingSeverity likewise.
	FindingTitle    string `json:"finding_title,omitempty"`
	FindingSeverity string `json:"finding_severity,omitempty"`
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

// ListSrcVendors returns vendors, optionally filtered by platform ("" = all).
func (d *DB) ListSrcVendors(platform string) ([]*SrcVendor, error) {
	q := `SELECT id,platform,name,domain,root_domain,scope,industry,region,weight_zero,contact,enabled,created_at,updated_at
		FROM src_vendors`
	var args []any
	if platform != "" {
		q += ` WHERE platform=$1`
		args = append(args, platform)
	}
	q += ` ORDER BY enabled DESC, name`
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*SrcVendor
	for rows.Next() {
		v, err := scanSrcVendor(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetSrcVendor returns one vendor by id (nil when absent).
func (d *DB) GetSrcVendor(id int64) (*SrcVendor, error) {
	row := d.QueryRow(`SELECT id,platform,name,domain,root_domain,scope,industry,region,weight_zero,contact,enabled,created_at,updated_at
		FROM src_vendors WHERE id=$1`, id)
	v, err := scanSrcVendor(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return v, err
}

// SaveSrcVendor inserts (ID==0) or updates a vendor.
func (d *DB) SaveSrcVendor(v *SrcVendor) (int64, error) {
	scope := v.Scope
	if scope == nil {
		scope = []string{}
	}
	scopeJSON, _ := json.Marshal(cleanScope(scope))
	if v.ID == 0 {
		var id int64
		err := d.QueryRow(`INSERT INTO src_vendors(platform,name,domain,root_domain,scope,industry,region,weight_zero,contact,enabled)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
			v.Platform, strings.TrimSpace(v.Name), strings.TrimSpace(v.Domain), strings.TrimSpace(v.RootDomain),
			string(scopeJSON), v.Industry, v.Region, v.WeightZero, v.Contact, v.Enabled).Scan(&id)
		return id, err
	}
	_, err := d.Exec(`UPDATE src_vendors SET platform=$1,name=$2,domain=$3,root_domain=$4,scope=$5,
		industry=$6,region=$7,weight_zero=$8,contact=$9,enabled=$10 WHERE id=$11`,
		v.Platform, strings.TrimSpace(v.Name), strings.TrimSpace(v.Domain), strings.TrimSpace(v.RootDomain),
		string(scopeJSON), v.Industry, v.Region, v.WeightZero, v.Contact, v.Enabled, v.ID)
	return v.ID, err
}

// DeleteSrcVendor removes a vendor; existing submissions keep going with a NULL vendor.
func (d *DB) DeleteSrcVendor(id int64) error {
	_, err := d.Exec(`DELETE FROM src_vendors WHERE id=$1`, id)
	return err
}

func cleanScope(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, s := range in {
		s = strings.ToLower(strings.TrimSpace(s))
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanSrcVendor(r rowScanner) (*SrcVendor, error) {
	var v SrcVendor
	var scope []byte
	if err := r.Scan(&v.ID, &v.Platform, &v.Name, &v.Domain, &v.RootDomain, &scope,
		&v.Industry, &v.Region, &v.WeightZero, &v.Contact, &v.Enabled, &v.CreatedAt, &v.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(scope, &v.Scope)
	if v.Scope == nil {
		v.Scope = []string{}
	}
	return &v, nil
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

const submissionCols = `s.id,s.finding_id,s.vendor_id,s.platform,s.state,COALESCE(s.external_id,''),
	COALESCE(s.form,'{}'),COALESCE(s.materials,'[]'),COALESCE(s.blockers,'[]'),COALESCE(s.warnings,'[]'),
	COALESCE(s.note,''),s.submitted_at,s.reviewed_at,s.created_at,s.updated_at,
	COALESCE(v.name,''),COALESCE(f.name,''),COALESCE(f.severity,'')`

const submissionFrom = ` FROM finding_submissions s
	LEFT JOIN src_vendors v ON v.id = s.vendor_id
	LEFT JOIN findings f ON f.id = s.finding_id`

func scanSubmission(r rowScanner) (*FindingSubmission, error) {
	var s FindingSubmission
	var form, materials, blockers, warnings []byte
	if err := r.Scan(&s.ID, &s.FindingID, &s.VendorID, &s.Platform, &s.State, &s.ExternalID,
		&form, &materials, &blockers, &warnings, &s.Note, &s.SubmittedAt, &s.ReviewedAt,
		&s.CreatedAt, &s.UpdatedAt, &s.VendorName, &s.FindingTitle, &s.FindingSeverity); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(form, &s.Form)
	_ = json.Unmarshal(materials, &s.Materials)
	_ = json.Unmarshal(blockers, &s.Blockers)
	_ = json.Unmarshal(warnings, &s.Warnings)
	if s.Form == nil {
		s.Form = map[string]string{}
	}
	if s.Materials == nil {
		s.Materials = []SubmissionMaterial{}
	}
	return &s, nil
}

// ListFindingSubmissions returns submissions, optionally filtered by finding
// (0 = all) and platform ("" = all).
func (d *DB) ListFindingSubmissions(findingID int64, platform string) ([]*FindingSubmission, error) {
	q := `SELECT ` + submissionCols + submissionFrom + ` WHERE TRUE`
	var args []any
	if findingID > 0 {
		args = append(args, findingID)
		q += ` AND s.finding_id=$1`
	}
	if platform != "" {
		args = append(args, platform)
		q += ` AND s.platform=$` + strconv.Itoa(len(args))
	}
	q += ` ORDER BY s.id DESC LIMIT 500`
	rows, err := d.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*FindingSubmission
	for rows.Next() {
		s, err := scanSubmission(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// GetFindingSubmission returns one submission (nil when absent).
func (d *DB) GetFindingSubmission(id int64) (*FindingSubmission, error) {
	s, err := scanSubmission(d.QueryRow(`SELECT `+submissionCols+submissionFrom+` WHERE s.id=$1`, id))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return s, err
}

// ErrSubmissionConflict is returned when an open submission already exists for
// the same finding × platform × vendor (补天严禁多投).
var ErrSubmissionConflict = errors.New("该漏洞在此平台已有一条进行中的提交记录")

// SaveFindingSubmission inserts (ID==0) or updates a submission. An insert that
// collides with idx_finding_submissions_open returns ErrSubmissionConflict.
func (d *DB) SaveFindingSubmission(s *FindingSubmission) (int64, error) {
	formJSON, _ := json.Marshal(s.Form)
	matJSON, _ := json.Marshal(nonNilMaterials(s.Materials))
	blkJSON, _ := json.Marshal(nonNilMaps(s.Blockers))
	warnJSON, _ := json.Marshal(nonNilMaps(s.Warnings))
	if s.ID == 0 {
		var id int64
		err := d.QueryRowContext(context.Background(), `INSERT INTO finding_submissions
			(finding_id,vendor_id,platform,state,external_id,form,materials,blockers,warnings,note,submitted_at,reviewed_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
			s.FindingID, s.VendorID, s.Platform, s.State, s.ExternalID,
			string(formJSON), string(matJSON), string(blkJSON), string(warnJSON), s.Note,
			s.SubmittedAt, s.ReviewedAt).Scan(&id)
		if isUniqueViolation(err) {
			return 0, ErrSubmissionConflict
		}
		return id, err
	}
	_, err := d.ExecContext(context.Background(), `UPDATE finding_submissions SET
		vendor_id=$1,platform=$2,state=$3,external_id=$4,form=$5,materials=$6,blockers=$7,warnings=$8,
		note=$9,submitted_at=$10,reviewed_at=$11 WHERE id=$12`,
		s.VendorID, s.Platform, s.State, s.ExternalID, string(formJSON), string(matJSON),
		string(blkJSON), string(warnJSON), s.Note, s.SubmittedAt, s.ReviewedAt, s.ID)
	return s.ID, err
}

// DeleteFindingSubmission removes a submission row (materials on disk are the
// caller's responsibility).
func (d *DB) DeleteFindingSubmission(id int64) error {
	_, err := d.Exec(`DELETE FROM finding_submissions WHERE id=$1`, id)
	return err
}

func nonNilMaterials(in []SubmissionMaterial) []SubmissionMaterial {
	if in == nil {
		return []SubmissionMaterial{}
	}
	return in
}

func nonNilMaps(in []map[string]any) []map[string]any {
	if in == nil {
		return []map[string]any{}
	}
	return in
}

// isUniqueViolation reports a PostgreSQL 23505 error without importing pgconn
// here (db.go already depends on it; keep the check local and typed).
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "23505") || strings.Contains(err.Error(), "duplicate key value")
}
