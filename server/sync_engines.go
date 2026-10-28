package server

// 互联网资产测绘引擎客户端（FOFA / Quake / Hunter / ZoomEye / Shodan / Censys）。
//
// 参考 AutoHunter（app/engines/）的适配模式：每个引擎一个 client，按各自的
// API 约定（endpoint、鉴权、分页参数、返回结构）翻页拉取，归一化为统一
// engineAsset 后交给调用方入库。查询语句按所选引擎的官网语法原样请求，
// 不做跨引擎改写。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const engineHTTPTimeout = 60 * time.Second

// engineAsset 是所有引擎归一化后的单条资产。
type engineAsset struct {
	Host    string `json:"host"`    // 主机（域名或 IP，FOFA 的 host 可能带协议/端口）
	IP      string `json:"ip"`
	Port    int    `json:"port"`
	Title   string `json:"title"`
	Domain  string `json:"domain"`  // 根域/主域（引擎给的粗粒度 domain 字段）
	Org     string `json:"org"`     // 组织/公司
	URL     string `json:"url"`     // 完整 URL（http 服务时优先）
	Service string `json:"service"` // 非http协议名（部分引擎有 protocol/banner）
}

// enginePage 是单次翻页的归一化结果。
type enginePage struct {
	Assets     []engineAsset `json:"assets"`
	Total      int64         `json:"total"`       // 引擎报告的命中总数（尽力而为）
	NextCursor string        `json:"next_cursor"` // Censys 等游标翻页引擎专用
}

// engineClient 是一个测绘引擎的最小接口：按页号拉取一页。
// Censys 等游标引擎通过 pageNext 游标推进（page 从 1 开始时忽略 cursor）。
type engineClient interface {
	// Fetch 拉取一页。page 从 1 开始；cursor 为上一页返回的 NextCursor（可为空）。
	Fetch(ctx context.Context, query string, page int, size int, cursor string) (enginePage, error)
}

// engineHTTP 帮手：发起请求、校验状态码、读 body。
func engineHTTP(ctx context.Context, client *http.Client, method, fullURL string, headers map[string]string, body io.Reader) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, fullURL, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "ARTEX/1.0")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		// 引擎错误信息大多在 body 里，优先透出。
		msg := strings.TrimSpace(string(data))
		if len(msg) > 400 {
			msg = msg[:400]
		}
		if msg == "" {
			msg = resp.Status
		}
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, msg)
	}
	return data, nil
}

// ---------- FOFA ----------

// fofaClient GET {base}/api/v1/search/all?key=&qbase64=&fields=&page=&size=&full=false
type fofaClient struct {
	BaseURL string // 默认 https://fofa.info
	Key     string
	HTTP    *http.Client
}

func (c *fofaClient) Fetch(ctx context.Context, query string, page, size int, _ string) (enginePage, error) {
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = "https://fofa.info"
	}
	q := url.Values{}
	q.Set("key", c.Key)
	q.Set("qbase64", base64.StdEncoding.EncodeToString([]byte(query)))
	q.Set("fields", "host,ip,port,title,domain,org,protocol")
	q.Set("page", fmt.Sprintf("%d", page))
	q.Set("size", fmt.Sprintf("%d", size))
	q.Set("full", "false")
	data, err := engineHTTP(ctx, c.HTTP, http.MethodGet, base+"/api/v1/search/all?"+q.Encode(), nil, nil)
	if err != nil {
		return enginePage{}, err
	}
	var env struct {
		Error   bool     `json:"error"`
		ErrMsg  string   `json:"errmsg"`
		Size    int64    `json:"size"`
		Results [][]any  `json:"results"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return enginePage{}, fmt.Errorf("fofa 解析失败: %w", err)
	}
	if env.Error {
		return enginePage{}, fmt.Errorf("fofa: %s", env.ErrMsg)
	}
	out := enginePage{Total: env.Size}
	for _, row := range env.Results {
		a := engineAsset{}
		get := func(i int) string {
			if i < len(row) {
				if s, ok := row[i].(string); ok {
					return s
				}
			}
			return ""
		}
		a.Host, a.IP, a.Title, a.Domain, a.Org, a.Service = get(0), get(1), get(3), get(4), get(5), get(6)
		a.Port = atoiSafe(get(2))
		normalizeAsset(&a)
		if a.Host != "" || a.IP != "" {
			out.Assets = append(out.Assets, a)
		}
	}
	return out, nil
}

// ---------- Quake (360) ----------

// quakeClient POST {base}/api/v3/search/quake_service，头 X-QuakeToken。
type quakeClient struct {
	BaseURL string // 默认 https://quake.360.net
	Key     string
	HTTP    *http.Client
}

func (c *quakeClient) Fetch(ctx context.Context, query string, page, size int, _ string) (enginePage, error) {
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = "https://quake.360.net"
	}
	if size > 100 {
		size = 100
	}
	body := map[string]any{
		"query": query,
		"start": (page - 1) * size,
		"size":  size,
		"include": []string{"ip", "port", "hostname", "org", "service.http.host",
			"service.http.title", "service.name", "location.domain"},
	}
	payload, _ := json.Marshal(body)
	data, err := engineHTTP(ctx, c.HTTP, http.MethodPost, base+"/api/v3/search/quake_service",
		map[string]string{"X-QuakeToken": c.Key, "Content-Type": "application/json"}, strings.NewReader(string(payload)))
	if err != nil {
		return enginePage{}, err
	}
	var env struct {
		Code    int             `json:"code"`
		Message string          `json:"message"`
		Data    []struct {
			IP      string `json:"ip"`
			Port    int    `json:"port"`
			Service struct {
				Name string `json:"name"`
				HTTP struct {
					Host  string `json:"host"`
					Title string `json:"title"`
				} `json:"http"`
			} `json:"service"`
			Hostname []string `json:"hostname"`
			Org      string   `json:"org"`
		} `json:"data"`
		Meta struct {
			Pagination struct {
				Total int64 `json:"total"`
			} `json:"pagination"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return enginePage{}, fmt.Errorf("quake 解析失败: %w", err)
	}
	if env.Code != 0 {
		return enginePage{}, fmt.Errorf("quake: %s", env.Message)
	}
	out := enginePage{Total: env.Meta.Pagination.Total}
	for _, it := range env.Data {
		a := engineAsset{IP: it.IP, Port: it.Port, Org: it.Org, Service: it.Service.Name}
		a.Host = it.Service.HTTP.Host
		a.Title = it.Service.HTTP.Title
		if a.Host == "" && len(it.Hostname) > 0 {
			a.Host = it.Hostname[0]
		}
		normalizeAsset(&a)
		if a.Host != "" || a.IP != "" {
			out.Assets = append(out.Assets, a)
		}
	}
	return out, nil
}

// ---------- Hunter (鹰图) ----------

// hunterClient GET {base}/openApi/search?api-key=&search=<base64url>&page=&page_size=&is_web=3
type hunterClient struct {
	BaseURL string // 默认 https://hunter.qianxin.com
	Key     string
	HTTP    *http.Client
}

func (c *hunterClient) Fetch(ctx context.Context, query string, page, size int, _ string) (enginePage, error) {
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = "https://hunter.qianxin.com"
	}
	if size > 100 {
		size = 100
	}
	// Hunter 的 search 参数是 base64(url语法串) + "&&page=N&&pageSize=M" 的 base64url。
	inner := fmt.Sprintf("%s&&page=%d&&pageSize=%d", query, page, size)
	q := url.Values{}
	q.Set("api-key", c.Key)
	q.Set("search", base64.URLEncoding.EncodeToString([]byte(inner)))
	q.Set("page", fmt.Sprintf("%d", page))
	q.Set("page_size", fmt.Sprintf("%d", size))
	q.Set("is_web", "3")
	data, err := engineHTTP(ctx, c.HTTP, http.MethodGet, base+"/openApi/search?"+q.Encode(), nil, nil)
	if err != nil {
		return enginePage{}, err
	}
	var env struct {
		Code int    `json:"code"`
		Msg  string `json:"msg"`
		Data struct {
			Total int64 `json:"total"`
			Arr   []struct {
				URL      string `json:"url"`
				IP       string `json:"ip"`
				Port     int    `json:"port"`
				Domain   string `json:"domain"`
				WebTitle string `json:"web_title"`
				Company  string `json:"company"`
				Protocol string `json:"protocol"`
			} `json:"arr"`
		} `json:"data"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return enginePage{}, fmt.Errorf("hunter 解析失败: %w", err)
	}
	if env.Code != 200 {
		return enginePage{}, fmt.Errorf("hunter: %s", env.Msg)
	}
	out := enginePage{Total: env.Data.Total}
	for _, it := range env.Data.Arr {
		a := engineAsset{URL: it.URL, IP: it.IP, Port: it.Port, Domain: it.Domain,
			Title: it.WebTitle, Org: it.Company, Service: it.Protocol}
		a.Host = it.Domain
		if a.Host == "" {
			a.Host = urlHost(it.URL)
		}
		normalizeAsset(&a)
		if a.Host != "" || a.IP != "" {
			out.Assets = append(out.Assets, a)
		}
	}
	return out, nil
}

// ---------- ZoomEye ----------

// zoomeyeClient POST {base}/v2/search，头 API-KEY。
type zoomeyeClient struct {
	BaseURL string // 默认 https://api.zoomeye.ai
	Key     string
	HTTP    *http.Client
}

func (c *zoomeyeClient) Fetch(ctx context.Context, query string, page, size int, _ string) (enginePage, error) {
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = "https://api.zoomeye.ai"
	}
	if size > 1000 {
		size = 1000
	}
	body := map[string]any{
		"qbase64":  base64.StdEncoding.EncodeToString([]byte(query)),
		"page":     page,
		"pagesize": size,
		"fields":   "ip,port,domain,hostname,title,url,organization.name,service.name",
	}
	// 含 web 检索面词时走 web 搜索，否则 host 搜索（与 AutoHunter 同策略）。
	ql := strings.ToLower(query)
	if strings.Contains(ql, "title=") || strings.Contains(ql, "body=") || strings.Contains(ql, "web.") {
		body["sub_type"] = "web"
	}
	payload, _ := json.Marshal(body)
	data, err := engineHTTP(ctx, c.HTTP, http.MethodPost, base+"/v2/search",
		map[string]string{"API-KEY": c.Key, "Content-Type": "application/json"}, strings.NewReader(string(payload)))
	if err != nil {
		return enginePage{}, err
	}
	var env struct {
		Code int             `json:"code"`
		Msg  string          `json:"message"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return enginePage{}, fmt.Errorf("zoomeye 解析失败: %w", err)
	}
	if env.Code != 0 && env.Code != 200 && env.Code != 60000 {
		return enginePage{}, fmt.Errorf("zoomeye: %s", env.Msg)
	}
	// v2 返回 {total, list|matches: [...]}，字段容错解析。
	var inner struct {
		Total   int64           `json:"total"`
		List    []json.RawMessage `json:"list"`
		Matches []json.RawMessage `json:"matches"`
	}
	if err := json.Unmarshal(env.Data, &inner); err != nil {
		return enginePage{}, fmt.Errorf("zoomeye data 解析失败: %w", err)
	}
	out := enginePage{Total: inner.Total}
	rows := append(append([]json.RawMessage{}, inner.List...), inner.Matches...)
	for _, raw := range rows {
		var it struct {
			IP   string `json:"ip"`
			Port int    `json:"port"`
			Domain string `json:"domain"`
			Hostname string `json:"hostname"`
			Title  string `json:"title"`
			URL    string `json:"url"`
			Organization any `json:"organization"`
			Service any `json:"service"`
		}
		if err := json.Unmarshal(raw, &it); err != nil {
			continue
		}
		a := engineAsset{IP: it.IP, Port: it.Port, Domain: it.Domain, Title: it.Title, URL: it.URL}
		if it.Hostname != "" {
			a.Host = it.Hostname
		}
		if a.Host == "" {
			a.Host = it.Domain
		}
		a.Org = anyToString(it.Organization)
		a.Service = anyToString(it.Service)
		normalizeAsset(&a)
		if a.Host != "" || a.IP != "" {
			out.Assets = append(out.Assets, a)
		}
	}
	return out, nil
}

// ---------- Shodan ----------

// shodanClient GET {base}/shodan/host/search?key=&query=&page=
type shodanClient struct {
	BaseURL string // 默认 https://api.shodan.io
	Key     string
	HTTP    *http.Client
}

func (c *shodanClient) Fetch(ctx context.Context, query string, page, size int, _ string) (enginePage, error) {
	base := strings.TrimRight(c.BaseURL, "/")
	if base == "" {
		base = "https://api.shodan.io"
	}
	q := url.Values{}
	q.Set("key", c.Key)
	q.Set("query", query)
	q.Set("page", fmt.Sprintf("%d", page))
	data, err := engineHTTP(ctx, c.HTTP, http.MethodGet, base+"/shodan/host/search?"+q.Encode(), nil, nil)
	if err != nil {
		return enginePage{}, err
	}
	var env struct {
		Total   int64 `json:"total"`
		Matches []struct {
			Hostnames []string `json:"hostnames"`
			IPStr     string   `json:"ip_str"`
			Port      int      `json:"port"`
			Title     string   `json:"title"`
			Org       string   `json:"org"`
			Product   string   `json:"product"`
			Transport string   `json:"_shodan"`
		} `json:"matches"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return enginePage{}, fmt.Errorf("shodan 解析失败: %w", err)
	}
	out := enginePage{Total: env.Total}
	for _, it := range env.Matches {
		a := engineAsset{IP: it.IPStr, Port: it.Port, Title: it.Title, Org: it.Org}
		if len(it.Hostnames) > 0 {
			a.Host = it.Hostnames[0]
		}
		normalizeAsset(&a)
		if a.Host != "" || a.IP != "" {
			out.Assets = append(out.Assets, a)
		}
	}
	return out, nil
}

// ---------- Censys ----------

// censysClient 双模式：Key 形如 "API_ID:SECRET" 走 Legacy Search v2（Basic 鉴权）；
// 否则视为个人令牌走 Platform v3（Bearer + CenQL，游标翻页）。
type censysClient struct {
	Key     string
	HTTP    *http.Client
}

func (c *censysClient) Fetch(ctx context.Context, query string, page, size int, cursor string) (enginePage, error) {
	if idx := strings.Index(c.Key, ":"); idx > 0 && !strings.Contains(c.Key, " ") {
		return c.fetchLegacy(ctx, query, page, size, cursor)
	}
	return c.fetchPlatform(ctx, query, page, size, cursor)
}

// censysLegacyCreds splits "API_ID:SECRET".
func (c *censysClient) legacyCreds() (string, string, bool) {
	id, secret, ok := strings.Cut(c.Key, ":")
	return id, secret, ok && id != "" && secret != ""
}

func (c *censysClient) fetchLegacy(ctx context.Context, query string, page, size int, cursor string) (enginePage, error) {
	if size > 100 {
		size = 100
	}
	id, secret, ok := c.legacyCreds()
	if !ok {
		return enginePage{}, fmt.Errorf("censys key 需为 API_ID:SECRET 格式（legacy 模式）")
	}
	body := map[string]any{"q": query, "per_page": size}
	if cursor != "" {
		body["cursor"] = cursor
	} else {
		body["page"] = page
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://search.censys.io/api/v2/hosts/search", strings.NewReader(string(payload)))
	if err != nil {
		return enginePage{}, err
	}
	req.SetBasicAuth(id, secret)
	req.Header.Set("Content-Type", "application/json")
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: engineHTTPTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return enginePage{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return enginePage{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return enginePage{}, fmt.Errorf("HTTP %d: %.400s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var env struct {
		Code int `json:"code"`
		Result struct {
			Total   int64  `json:"total"`
			Cursor  string `json:"cursor"`
			Hits    []censysHit `json:"hits"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return enginePage{}, fmt.Errorf("censys 解析失败: %w", err)
	}
	out := enginePage{Total: env.Result.Total, NextCursor: env.Result.Cursor}
	for _, h := range env.Result.Hits {
		out.Assets = append(out.Assets, h.toAsset()...)
	}
	return out, nil
}

type censysHit struct {
	IP          string   `json:"ip"`
	DNS         struct {
		Names []string `json:"names"`
	} `json:"dns"`
	AutonomousSystem struct {
		Organization string `json:"organization"`
	} `json:"autonomous_system"`
	Services []struct {
		Port       int    `json:"port"`
		Transport  string `json:"transport_protocol"`
		ServiceName string `json:"service_name"`
		HTTP       struct {
			Response struct {
				HTMLTitle string `json:"html_title"`
			} `json:"response"`
		} `json:"http"`
	} `json:"services"`
}

func (h censysHit) toAsset() []engineAsset {
	var assets []engineAsset
	for _, svc := range h.Services {
		a := engineAsset{IP: h.IP, Port: svc.Port, Title: svc.HTTP.Response.HTMLTitle, Org: h.AutonomousSystem.Organization}
		if len(h.DNS.Names) > 0 {
			a.Host = h.DNS.Names[0]
		}
		if svc.ServiceName == "HTTP" || strings.EqualFold(svc.Transport, "tcp") && (svc.Port == 80 || svc.Port == 443) {
			scheme := "http"
			if svc.Port == 443 {
				scheme = "https"
			}
			a.URL = fmt.Sprintf("%s://%s:%d", scheme, hostOrIP(a.Host, h.IP), svc.Port)
		} else {
			a.Service = svc.ServiceName
		}
		normalizeAsset(&a)
		if a.Host != "" || a.IP != "" {
			assets = append(assets, a)
		}
	}
	return assets
}

func (c *censysClient) fetchPlatform(ctx context.Context, query string, page, size int, cursor string) (enginePage, error) {
	if size > 100 {
		size = 100
	}
	body := map[string]any{"query": query, "page_size": size}
	if cursor != "" {
		body["page_token"] = cursor
	}
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.platform.censys.io/v3/global/search/query", strings.NewReader(string(payload)))
	if err != nil {
		return enginePage{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.Key)
	req.Header.Set("Content-Type", "application/json")
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: engineHTTPTimeout}
	}
	resp, err := client.Do(req)
	if err != nil {
		return enginePage{}, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return enginePage{}, err
	}
	if resp.StatusCode != http.StatusOK {
		return enginePage{}, fmt.Errorf("HTTP %d: %.400s", resp.StatusCode, strings.TrimSpace(string(data)))
	}
	var env struct {
		Result struct {
			NextPageToken string `json:"next_page_token"`
			Hits          []struct {
				HostV1 censysHit `json:"host_v1"`
			} `json:"hits"`
		} `json:"result"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return enginePage{}, fmt.Errorf("censys 解析失败: %w", err)
	}
	out := enginePage{NextCursor: env.Result.NextPageToken}
	for _, h := range env.Result.Hits {
		out.Assets = append(out.Assets, h.HostV1.toAsset()...)
	}
	return out, nil
}

// ---------- 小工具 ----------

func atoiSafe(s string) int {
	n := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
	}
	return n
}

// urlHost extracts the host from a URL string, tolerating missing scheme.
func urlHost(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	if u, err := url.Parse(raw); err == nil {
		return u.Hostname()
	}
	return ""
}

func anyToString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case map[string]any:
		if name, ok := t["name"].(string); ok {
			return name
		}
	}
	return ""
}

func hostOrIP(host, ip string) string {
	if host != "" {
		return host
	}
	return ip
}

// normalizeAsset 收尾清洗：host 里的协议/端口剥离、http 服务构造 URL、domain 补全。
func normalizeAsset(a *engineAsset) {
	// FOFA 的 host 可能是 "https://example.com:8443" 形态。
	if strings.Contains(a.Host, "://") {
		if a.URL == "" {
			a.URL = a.Host
		}
		a.Host = urlHost(a.Host)
	}
	if h, p := splitHostPort(a.Host); h != "" && p > 0 {
		a.Host, a.Port = h, p
	}
	// http 服务没有 URL 时按端口协议补一个，入库走 HTTP 服务分支。
	if a.URL == "" && a.Port > 0 && a.Service == "" {
		scheme := ""
		if a.Port == 80 || a.Port == 443 || a.Port == 8080 || a.Port == 8443 {
			scheme = "http"
			if a.Port == 443 || a.Port == 8443 {
				scheme = "https"
			}
		}
		if scheme != "" {
			a.URL = fmt.Sprintf("%s://%s:%d", scheme, hostOrIP(a.Host, a.IP), a.Port)
		}
	}
	a.Host = strings.TrimSpace(a.Host)
	a.Domain = strings.TrimSpace(a.Domain)
	a.IP = strings.TrimSpace(a.IP)
}

func splitHostPort(hostport string) (string, int) {
	i := strings.LastIndex(hostport, ":")
	if i < 0 {
		return hostport, 0
	}
	port := atoiSafe(hostport[i+1:])
	if port == 0 {
		return hostport, 0
	}
	return strings.Trim(hostport[:i], "[]"), port
}
