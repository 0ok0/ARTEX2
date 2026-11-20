package server

// 互联网资产测绘同步（测绘搜资产）。
//
// 参考 AutoHunter 的"测绘搜资产"能力：创建任务/同步资产时可用 FOFA、Quake、
// Hunter、ZoomEye、Shodan、Censys 六个引擎按查询语法（或大白话意图经 LLM 转
// 语法）拉取互联网资产，归一化后入 ARTEX 资产图（服务/子域/IP），并可选按
// 主域建立公司范围。
//
// 各引擎的 Key/端点存在 settings 表（key: engine_<name>），可经
// POST /api/sync/engines/datasource 配置；意图转语法复用全局激活的 LLM。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/Autumn-27/artex/db"
	"github.com/Autumn-27/norma/llm"
)

const (
	settingEnginePrefix = "engine_"        // settings key 前缀: engine_fofa = JSON
	engineSyncTimeout   = 10 * time.Minute // 单次同步总预算
	engineLLMTimeout    = 90 * time.Second // 意图转语法超时
	engineMaxTotal      = 10000            // 单次同步全引擎入库保护上限
)

// engineSetting 保存每个引擎的配置（settings 表里一段 JSON）。
type engineSetting struct {
	Enabled bool   `json:"enabled"`
	Key     string `json:"key"`
	BaseURL string `json:"base_url"`
}

var knownEngines = []string{"fofa", "quake", "hunter", "zoomeye", "shodan", "censys"}

// loadEngineSettings reads all engine configs into a map.
func (s *Server) loadEngineSettings() (map[string]engineSetting, error) {
	out := map[string]engineSetting{}
	if s.m.pg == nil {
		return out, nil
	}
	for _, name := range knownEngines {
		v, ok, err := s.m.pg.GetSetting(settingEnginePrefix + name)
		if err != nil || !ok || v == "" {
			continue
		}
		var es engineSetting
		if err := json.Unmarshal([]byte(v), &es); err == nil {
			out[name] = es
		}
	}
	return out, nil
}

// saveEngineSetting persists one engine config.
func (s *Server) saveEngineSetting(name string, es engineSetting) error {
	raw, err := json.Marshal(es)
	if err != nil {
		return err
	}
	return s.m.pg.SetSetting(settingEnginePrefix+name, string(raw))
}

// engineByName builds the concrete client for an engine name using saved config.
func engineByName(name string, es engineSetting, client *http.Client) (engineClient, error) {
	switch name {
	case "fofa":
		if es.Key == "" {
			return nil, fmt.Errorf("FOFA 未配置 Key")
		}
		return &fofaClient{BaseURL: es.BaseURL, Key: es.Key, HTTP: client}, nil
	case "quake":
		if es.Key == "" {
			return nil, fmt.Errorf("Quake 未配置 Key")
		}
		return &quakeClient{BaseURL: es.BaseURL, Key: es.Key, HTTP: client}, nil
	case "hunter":
		if es.Key == "" {
			return nil, fmt.Errorf("Hunter 未配置 Key")
		}
		return &hunterClient{BaseURL: es.BaseURL, Key: es.Key, HTTP: client}, nil
	case "zoomeye":
		if es.Key == "" {
			return nil, fmt.Errorf("ZoomEye 未配置 Key")
		}
		return &zoomeyeClient{BaseURL: es.BaseURL, Key: es.Key, HTTP: client}, nil
	case "shodan":
		if es.Key == "" {
			return nil, fmt.Errorf("Shodan 未配置 Key")
		}
		return &shodanClient{BaseURL: es.BaseURL, Key: es.Key, HTTP: client}, nil
	case "censys":
		if es.Key == "" {
			return nil, fmt.Errorf("Censys 未配置 Key")
		}
		return &censysClient{Key: es.Key, HTTP: client}, nil
	}
	return nil, fmt.Errorf("未知引擎: %s", name)
}

// ---------- GET /api/sync/engines/status ----------

func (s *Server) syncEnginesStatus(w http.ResponseWriter, r *http.Request) {
	if s.pg(w) == nil {
		return
	}
	settings, err := s.loadEngineSettings()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	engines := map[string]any{}
	for _, name := range knownEngines {
		es, ok := settings[name]
		entry := map[string]any{"enabled": false, "configured": false, "base_url": ""}
		if ok {
			entry["enabled"] = es.Enabled
			entry["configured"] = strings.TrimSpace(es.Key) != ""
			entry["base_url"] = es.BaseURL
		}
		engines[name] = entry
	}
	// LLM 可用性（意图转语法依赖）
	s.cfgMu.Lock()
	llmReady := s.llmOn && s.llmProv != nil
	llmModel := ""
	if llmReady {
		llmModel = s.llmCfg.Model
	}
	s.cfgMu.Unlock()
	writeJSON(w, 200, map[string]any{"engines": engines, "llm_ready": llmReady, "llm_model": llmModel})
}

// ---------- POST /api/sync/engines/datasource ----------

type engineDatasourceReq struct {
	Engine  string  `json:"engine"`
	Enabled *bool   `json:"enabled"` // nil = 不改
	Key     *string `json:"key"`     // nil = 不改；指针空串 = 清除
	BaseURL *string `json:"base_url"`
}

func (s *Server) syncEnginesDatasource(w http.ResponseWriter, r *http.Request) {
	pg := s.pg(w)
	if pg == nil {
		return
	}
	var req engineDatasourceReq
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, "invalid JSON: "+err.Error())
		return
	}
	req.Engine = strings.ToLower(strings.TrimSpace(req.Engine))
	valid := false
	for _, n := range knownEngines {
		if n == req.Engine {
			valid = true
		}
	}
	if !valid {
		writeErr(w, 400, "未知引擎: "+req.Engine)
		return
	}
	settings, err := s.loadEngineSettings()
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	es := settings[req.Engine]
	if req.Key != nil {
		es.Key = strings.TrimSpace(*req.Key)
	}
	if req.BaseURL != nil {
		es.BaseURL = strings.TrimSpace(*req.BaseURL)
	}
	if req.Enabled != nil {
		es.Enabled = *req.Enabled && es.Key != ""
	} else {
		es.Enabled = es.Key != ""
	}
	if err := s.saveEngineSetting(req.Engine, es); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"engine": req.Engine, "enabled": es.Enabled, "configured": es.Key != ""})
}

// ---------- POST /api/sync/engines/search ----------
// 预览搜索：按页号拉一页归一化资产给前端预览，不入库。

type engineSearchReq struct {
	Engine string `json:"engine"`
	Query  string `json:"query"`  // 查询语法或大白话意图
	Intent bool   `json:"intent"` // true = query 是大白话，先经 LLM 转语法
	Page   int    `json:"page"`
	Size   int    `json:"size"`
}

func (s *Server) syncEnginesSearch(w http.ResponseWriter, r *http.Request) {
	if s.pg(w) == nil {
		return
	}
	var req engineSearchReq
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, "invalid JSON: "+err.Error())
		return
	}
	req.Engine = strings.ToLower(strings.TrimSpace(req.Engine))
	if req.Page <= 0 {
		req.Page = 1
	}
	if req.Size <= 0 || req.Size > 500 {
		req.Size = 100
	}
	resolved, err := s.resolveEngineQuery(r.Context(), req.Engine, req.Query, req.Intent)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	page, err := s.engineFetchPage(r.Context(), req.Engine, resolved, req.Page, req.Size, "")
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"query": resolved, "page": page})
}

// resolveEngineQuery turns an intent (natural language) into engine syntax via the
// active LLM, or returns the query as-is for syntax mode.
func (s *Server) resolveEngineQuery(ctx context.Context, engine, query string, intent bool) (string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return "", fmt.Errorf("query 不能为空")
	}
	if !intent {
		return query, nil
	}
	s.cfgMu.Lock()
	prov, cfg, on := s.llmProv, s.llmCfg, s.llmOn
	s.cfgMu.Unlock()
	if !on || prov == nil {
		return "", fmt.Errorf("LLM 未配置，无法进行意图转换；请直接填写该引擎的查询语法")
	}
	lctx, cancel := context.WithTimeout(ctx, engineLLMTimeout)
	defer cancel()
	prompt := fmt.Sprintf(
		"你是测绘引擎查询语法专家。把下面的大白话需求转写为 %s 引擎的官网查询语法（只输出语法本身，不要解释、不要引号包裹、不要 markdown）。\n"+
			"语法要求遵循该引擎官方文档；如果需求无法表达为语法，就给出最接近的保守语法。\n\n需求：%s", engine, query)
	reqMsg := llm.CompletionRequest{
		System:      []string{"You translate natural-language recon requirements into search-engine query syntax. Output only the query."},
		Messages:    []llm.Message{llm.UserText(prompt)},
		MaxTokens:   512,
		Temperature: floatPtr(0.2),
		Thinking:    "disabled",
	}
	msg, _, _, err := prov.Complete(lctx, reqMsg)
	if err != nil {
		return "", fmt.Errorf("意图转语法失败(%s): %v", cfg.Model, err)
	}
	out := strings.TrimSpace(msg.Text())
	out = strings.Trim(out, "`\"' \n\t")
	if out == "" {
		return query, nil // LLM 空回复时退回原文，让引擎直接报错更直观
	}
	return out, nil
}

func floatPtr(f float64) *float64 { return &f }

// engineFetchPage fetches one page from the named engine.
func (s *Server) engineFetchPage(ctx context.Context, engine, query string, page, size int, cursor string) (enginePage, error) {
	settings, err := s.loadEngineSettings()
	if err != nil {
		return enginePage{}, err
	}
	es := settings[engine]
	if es.Key == "" || !es.Enabled {
		return enginePage{}, fmt.Errorf("%s 未配置 Key 或未启用", engine)
	}
	cl, err := engineByName(engine, es, &http.Client{Timeout: engineHTTPTimeout})
	if err != nil {
		return enginePage{}, err
	}
	return cl.Fetch(ctx, query, page, size, cursor)
}

// ---------- POST /api/sync/engines/sync ----------
// 正式同步：翻页拉取全部结果并入库（服务/子域/IP + 可选公司范围）。

type engineSyncReq struct {
	Engine        string `json:"engine"`
	Query         string `json:"query"`
	Intent        bool   `json:"intent"`
	MaxPages      int    `json:"max_pages"`      // 翻页保护上限
	PageSize      int    `json:"page_size"`      // 默认 100
	CreateCompany bool   `json:"create_company"` // 按主域建公司 + scope
}

func (s *Server) syncEnginesRun(w http.ResponseWriter, r *http.Request) {
	if s.pg(w) == nil {
		return
	}
	as := s.assetStore()
	cs := s.companyStore()
	if as == nil || cs == nil {
		writeErr(w, 503, "database unavailable")
		return
	}
	var req engineSyncReq
	if err := decode(r, &req); err != nil {
		writeErr(w, 400, "invalid JSON: "+err.Error())
		return
	}
	req.Engine = strings.ToLower(strings.TrimSpace(req.Engine))
	if req.MaxPages <= 0 {
		req.MaxPages = 10
	}
	if req.MaxPages > 100 {
		req.MaxPages = 100
	}
	if req.PageSize <= 0 || req.PageSize > 500 {
		req.PageSize = 100
	}
	ctx, cancel := context.WithTimeout(r.Context(), engineSyncTimeout)
	defer cancel()

	resolved, err := s.resolveEngineQuery(ctx, req.Engine, req.Query, req.Intent)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}

	// 逐页拉取 + 入库；host 去重由资产图 upsert 的幂等性兜底，这里再做一层
	// 进程内去重避免同一页结果里重复行反复触发 upsert。
	seen := map[string]bool{}
	synced := map[string]int{"service": 0, "subdomain": 0, "ip": 0, "root_domain": 0, "skipped": 0}
	var warnings, errs []string
	total := 0
	var companyNames []string

	for page := 1; page <= req.MaxPages; page++ {
		pgData, ferr := s.engineFetchPage(ctx, req.Engine, resolved, page, req.PageSize, "")
		if ferr != nil {
			errs = append(errs, fmt.Sprintf("第 %d 页拉取失败: %v", page, ferr))
			break
		}
		if len(pgData.Assets) == 0 {
			break
		}
		capped := false
		for _, a := range pgData.Assets {
			key := a.Host + "|" + a.IP + "|" + fmt.Sprint(a.Port)
			if seen[key] {
				continue
			}
			seen[key] = true
			if e := s.engineIngest(as, cs, req.CreateCompany, a, synced, &companyNames); e != "" {
				errs = append(errs, e)
			}
			total++
			if total >= engineMaxTotal {
				warnings = append(warnings, fmt.Sprintf("达到 %d 条入库上限，提前收尾", engineMaxTotal))
				capped = true
				break
			}
		}
		if capped {
			break
		}
		if len(pgData.Assets) < req.PageSize {
			break
		}
	}
	if len(companyNames) > 0 {
		_ = cs.RecomputeAttribution()
	}
	writeJSON(w, 200, map[string]any{
		"engine":    req.Engine,
		"query":     resolved,
		"pages":     len(seen) > 0,
		"synced":    synced,
		"companies": companyNames,
		"warnings":  warnings,
		"errors":    errs,
	})
}

// engineIngest maps one normalized engine asset into the ARTEX asset store.
func (s *Server) engineIngest(as *db.AssetStore, cs *db.CompanyStore, createCompany bool, a engineAsset, synced map[string]int, companyNames *[]string) string {
	// HTTP 服务（有 URL）优先。
	if a.URL != "" {
		var tech []string
		if a.Org != "" {
			tech = []string{"org:" + a.Org}
		}
		if _, err := as.UpsertHTTPService(db.UpsertHTTPServiceReq{
			URL: a.URL, PageTitle: a.Title, IP: a.IP, Technologies: tech,
		}); err != nil {
			return "service " + a.URL + ": " + err.Error()
		}
		synced["service"]++
	} else if a.Host != "" && a.Port > 0 && a.IP != "" && !isLikelyHTTPPort(a.Port) {
		if _, err := as.UpsertOtherService(db.UpsertOtherServiceReq{
			Domain: a.Host, IP: a.IP, Port: a.Port, ServiceName: a.Service,
		}); err != nil {
			return "service " + a.IP + ":" + fmt.Sprint(a.Port) + ": " + err.Error()
		}
		synced["service"]++
	} else if a.Host != "" && !strings.Contains(a.Host, ":") {
		// 纯主机名按子域入库（UpsertSubdomain 会自动补 root_domain + IP 绑定）。
		if _, err := as.UpsertSubdomain(db.UpsertSubdomainReq{Domain: a.Host}); err != nil {
			return "subdomain " + a.Host + ": " + err.Error()
		}
		synced["subdomain"]++
	} else {
		synced["skipped"]++
	}
	// 独立 IP 也补一条 ip 资产。
	if a.IP != "" && strings.Contains(a.IP, ".") {
		bound := []string{}
		if a.Host != "" {
			bound = append(bound, a.Host)
		}
		if _, err := as.UpsertIP(db.UpsertIPReq{IP: a.IP, BoundDomains: bound}); err == nil {
			synced["ip"]++
		}
	}
	// 可选：按主域建公司 + scope。
	if createCompany {
		root := rootOf(a.Host)
		if root == "" {
			root = rootOf(a.Domain)
		}
		if root != "" && root != "*" {
			cid, err := cs.UpsertByName(root)
			if err == nil {
				found := false
				for _, n := range *companyNames {
					if n == root {
						found = true
					}
				}
				if !found {
					*companyNames = append(*companyNames, root)
					cs.AddScope(cid, []string{root}, "engine-sync")
				}
			}
		}
	}
	return ""
}

func isLikelyHTTPPort(port int) bool {
	switch port {
	case 80, 443, 8080, 8443, 8000, 8888, 7001, 9090, 4430:
		return true
	}
	return false
}

// rootOf returns the registrable-ish root domain (last two labels; handles common
// second-level suffixes like com.cn / edu.cn).
func rootOf(domain string) string {
	domain = strings.ToLower(strings.TrimSpace(domain))
	if domain == "" || strings.Contains(domain, " ") || strings.Contains(domain, "/") {
		return ""
	}
	if ip := strings.Trim(domain, "[]"); strings.Count(ip, ".") == 3 && atoiSafe(strings.ReplaceAll(ip, ".", "")) > 0 {
		return "" // 不是域名
	}
	parts := strings.Split(domain, ".")
	if len(parts) < 2 {
		return domain
	}
	two := parts[len(parts)-2] + "." + parts[len(parts)-1]
	secondLevel := map[string]bool{"com.cn": true, "net.cn": true, "org.cn": true, "gov.cn": true, "edu.cn": true, "ac.cn": true}
	if secondLevel[two] && len(parts) >= 3 {
		return parts[len(parts)-3] + "." + two
	}
	return two
}
