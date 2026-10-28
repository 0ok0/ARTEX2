"use client";

import * as React from "react";

import { AlertCircleIcon, CheckCircle2Icon, DownloadIcon, PlugZapIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import type { EngineAsset, SSProject, SSTask } from "@/lib/types";

type SSStatus = {
  exists: boolean;
  configured: boolean;
  enabled: boolean;
  reachable: boolean;
  url?: string;
  tools: string[];
};

type Dimension = "project" | "task";

const ASSET_TYPES: { key: string; label: string }[] = [
  { key: "subdomain", label: "子域名" },
  { key: "service", label: "服务" },
  { key: "app", label: "App" },
];

export default function AssetSyncPage() {
  return (
    <div className="p-4 md:p-6">
      <div className="mb-4">
        <h1 className="font-semibold text-xl">资产同步</h1>
        <p className="text-muted-foreground text-sm">从外部数据源同步资产入库</p>
      </div>
      <Tabs defaultValue="scopesentry">
        <TabsList>
          <TabsTrigger value="scopesentry">ScopeSentry</TabsTrigger>
          <TabsTrigger value="engines">测绘引擎</TabsTrigger>
        </TabsList>
        <TabsContent value="scopesentry" className="mt-4">
          <ScopeSentryPanel />
        </TabsContent>
        <TabsContent value="engines" className="mt-4">
          <EnginesPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ScopeSentryPanel() {
  const [status, setStatus] = React.useState<SSStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = React.useState(true);

  const loadStatus = React.useCallback(() => {
    setLoadingStatus(true);
    api
      .ssStatus()
      .then(setStatus)
      .catch((e) => toast.error(`读取数据源状态失败：${e.message}`))
      .finally(() => setLoadingStatus(false));
  }, []);

  React.useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const ready = !!status && status.exists && status.configured && status.enabled;

  return (
    <div className="space-y-4">
      <DataSourceCard status={status} loading={loadingStatus} onChanged={loadStatus} />
      {ready ? (
        <SyncWorkbench />
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            数据源就绪后即可选择项目 / 任务进行同步。
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── 数据源状态卡 ─────────────────────────────────────────────────────────────

function DataSourceCard({
  status,
  loading,
  onChanged,
}: {
  status: SSStatus | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const [url, setUrl] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (status?.url) setUrl(status.url);
  }, [status?.url]);

  const create = async () => {
    setBusy(true);
    try {
      await api.ssDatasource({});
      toast.success("已创建 ScopeSentry 数据源，请填写地址与密钥");
      onChanged();
    } catch (e) {
      toast.error(`创建失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!url.trim()) return toast.error("请填写 MCP 地址");
    setBusy(true);
    try {
      const r = await api.ssDatasource({ url: url.trim(), api_key: apiKey.trim() });
      toast.success(r.enabled ? "已保存并启用数据源" : "已保存（尚未满足启用条件）");
      setApiKey("");
      onChanged();
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <PlugZapIcon className="size-4" /> 数据源状态
          <StatusBadge status={status} loading={loading} />
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={onChanged} disabled={loading}>
          <RefreshCwIcon className={loading ? "size-4 animate-spin" : "size-4"} /> 刷新
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!status?.exists ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-muted-foreground text-sm">
              尚未创建 ScopeSentry 数据源。创建后会新增一个占位 MCP（地址/密钥为空、未启用）。
            </p>
            <Button onClick={create} disabled={busy}>
              创建数据源
            </Button>
          </div>
        ) : (
          <>
            {!status.configured && (
              <p className="text-amber-600 text-sm dark:text-amber-500">
                数据源已创建但未配置，请填写 MCP 地址与 API Key 后启用。
              </p>
            )}
            {status.configured && !status.enabled && (
              <p className="text-amber-600 text-sm dark:text-amber-500">数据源已配置但未启用，保存后将自动启用。</p>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>MCP 地址</Label>
                <Input placeholder="http://<主机>:8082/mcp" value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>API Key（X-API-Key，留空保留原值）</Label>
                <Input
                  type="password"
                  placeholder="ssk_..."
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button onClick={save} disabled={busy}>
                保存并启用
              </Button>
              {status.enabled && status.tools.length > 0 && (
                <span className="text-muted-foreground text-xs">已发现 {status.tools.length} 个工具</span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status, loading }: { status: SSStatus | null; loading: boolean }) {
  if (loading || !status) return <Badge variant="secondary">检测中…</Badge>;
  if (!status.exists) return <Badge variant="destructive">未创建</Badge>;
  if (!status.configured) return <Badge variant="outline">未配置</Badge>;
  if (!status.enabled) return <Badge variant="outline">未启用</Badge>;
  if (status.reachable)
    return (
      <Badge className="bg-emerald-600 hover:bg-emerald-600">
        <CheckCircle2Icon className="mr-1 size-3" /> 已连接
      </Badge>
    );
  return (
    <Badge variant="destructive">
      <AlertCircleIcon className="mr-1 size-3" /> 不可达
    </Badge>
  );
}

// ── 同步工作区（项目 / 任务维度）────────────────────────────────────────────────

function SyncWorkbench() {
  const [dimension, setDimension] = React.useState<Dimension>("project");
  const [assetTypes, setAssetTypes] = React.useState<Record<string, boolean>>({
    subdomain: true,
    service: true,
    app: true,
  });
  const [createCompany, setCreateCompany] = React.useState(true);

  const [projects, setProjects] = React.useState<SSProject[]>([]);
  const [tasks, setTasks] = React.useState<SSTask[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const [syncing, setSyncing] = React.useState(false);
  const [result, setResult] = React.useState<Awaited<ReturnType<typeof api.ssSync>> | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setSelected(new Set());
    const fn =
      dimension === "project"
        ? api.ssProjects(page, 50, search).then((r) => setProjects(r.projects))
        : api.ssTasks(page, 50, search).then(setTasks);
    fn.catch((e) => toast.error(`加载列表失败：${e.message}`)).finally(() => setLoading(false));
  }, [dimension, page, search]);

  React.useEffect(() => {
    load();
  }, [load]);

  const rows = dimension === "project" ? projects : tasks;
  const idOf = (row: SSProject | SSTask) => (dimension === "project" ? (row as SSProject).id : (row as SSTask).name);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => (prev.size === rows.length ? new Set() : new Set(rows.map(idOf))));
  };

  const chosenTypes = ASSET_TYPES.filter((t) => assetTypes[t.key]).map((t) => t.key);

  const runSync = async () => {
    if (selected.size === 0) return toast.error(`请至少选择一个${dimension === "project" ? "项目" : "任务"}`);
    if (chosenTypes.length === 0) return toast.error("请至少选择一种资产类型");
    setSyncing(true);
    setResult(null);
    try {
      const r = await api.ssSync({
        dimension,
        targets: [...selected],
        asset_types: chosenTypes,
        create_company: dimension === "project" ? createCompany : false,
      });
      setResult(r);
      const total = Object.values(r.synced ?? {}).reduce((a, b) => a + b, 0);
      toast.success(`同步完成，共入库 ${total} 条资产`);
    } catch (e) {
      toast.error(`同步失败：${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const renderRows = () => {
    if (loading) {
      return (
        <TableRow>
          <TableCell colSpan={4} className="py-8 text-center text-muted-foreground text-sm">
            加载中…
          </TableCell>
        </TableRow>
      );
    }
    if (rows.length === 0) {
      return (
        <TableRow>
          <TableCell colSpan={4} className="py-8 text-center text-muted-foreground text-sm">
            无数据
          </TableCell>
        </TableRow>
      );
    }
    if (dimension === "project") {
      return projects.map((p) => (
        <TableRow key={p.id} className="cursor-pointer" onClick={() => toggle(p.id)}>
          <TableCell onClick={(e) => e.stopPropagation()}>
            <Checkbox checked={selected.has(p.id)} onCheckedChange={() => toggle(p.id)} />
          </TableCell>
          <TableCell className="font-medium">{p.name}</TableCell>
          <TableCell>{p.tag ? <Badge variant="secondary">{p.tag}</Badge> : "—"}</TableCell>
          <TableCell className="text-right">{p.AssetCount ?? 0}</TableCell>
        </TableRow>
      ));
    }
    return tasks.map((t) => (
      <TableRow key={t.id} className="cursor-pointer" onClick={() => toggle(t.name)}>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selected.has(t.name)} onCheckedChange={() => toggle(t.name)} />
        </TableCell>
        <TableCell className="font-medium">{t.name}</TableCell>
        <TableCell>
          <Badge variant={t.progress === 100 ? "secondary" : "outline"}>
            {t.progress != null ? `${t.progress}%` : "—"}
          </Badge>
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">{t.endTime || t.creatTime || "—"}</TableCell>
      </TableRow>
    ));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">选择数据同步</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 维度切换 */}
        <Tabs
          value={dimension}
          onValueChange={(v) => {
            setDimension(v as Dimension);
            setPage(1);
          }}
        >
          <TabsList>
            <TabsTrigger value="project">项目维度</TabsTrigger>
            <TabsTrigger value="task">任务维度</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* 资产类型 + 选项 */}
        <div className="flex flex-wrap items-center gap-4">
          <span className="font-medium text-sm">同步资产：</span>
          {ASSET_TYPES.map((t) => (
            <label key={t.key} htmlFor={`at-${t.key}`} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                id={`at-${t.key}`}
                checked={!!assetTypes[t.key]}
                onCheckedChange={(c) => setAssetTypes((prev) => ({ ...prev, [t.key]: !!c }))}
              />
              {t.label}
            </label>
          ))}
          {dimension === "project" && (
            <label htmlFor="create-company" className="flex items-center gap-1.5 text-sm">
              <Checkbox id="create-company" checked={createCompany} onCheckedChange={(c) => setCreateCompany(!!c)} />
              按项目建立企业并写入资产范围
            </label>
          )}
        </div>

        {/* 搜索 + 操作 */}
        <div className="flex items-center gap-2">
          <div className="relative max-w-xs flex-1">
            <SearchIcon className="absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder={dimension === "project" ? "搜索项目名" : "搜索任务名"}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  setPage(1);
                  load();
                }
              }}
            />
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCwIcon className={loading ? "size-4 animate-spin" : "size-4"} />
          </Button>
          <div className="flex-1" />
          <span className="text-muted-foreground text-xs">已选 {selected.size}</span>
          <Button onClick={runSync} disabled={syncing || selected.size === 0}>
            <DownloadIcon className={syncing ? "size-4 animate-pulse" : "size-4"} /> 同步选中
          </Button>
        </div>

        {/* 列表 */}
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox checked={rows.length > 0 && selected.size === rows.length} onCheckedChange={toggleAll} />
                </TableHead>
                <TableHead>{dimension === "project" ? "项目名" : "任务名"}</TableHead>
                {dimension === "project" ? (
                  <>
                    <TableHead>标签</TableHead>
                    <TableHead className="text-right">资产数</TableHead>
                  </>
                ) : (
                  <>
                    <TableHead>状态</TableHead>
                    <TableHead>时间</TableHead>
                  </>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>{renderRows()}</TableBody>
          </Table>
        </div>

        {/* 分页 */}
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
            上一页
          </Button>
          <span className="text-muted-foreground text-xs">第 {page} 页</span>
          <Button
            variant="outline"
            size="sm"
            disabled={rows.length < 50 || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </Button>
        </div>

        {/* 结果 */}
        {result && <SyncResult result={result} />}
      </CardContent>
    </Card>
  );
}

function SyncResult({ result }: { result: Awaited<ReturnType<typeof api.ssSync>> }) {
  const synced = result.synced ?? {};
  const labels: Record<string, string> = { subdomain: "子域名", service: "服务", app: "App", ip: "IP" };
  return (
    <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-sm">
      <div className="flex flex-wrap gap-3">
        {Object.entries(synced).map(([k, v]) => (
          <Badge key={k} variant="secondary">
            {labels[k] ?? k}: {v}
          </Badge>
        ))}
      </div>
      {result.companies && result.companies.length > 0 && (
        <p className="text-muted-foreground">新建/更新企业：{result.companies.join("、")}</p>
      )}
      {result.warnings && result.warnings.length > 0 && (
        <ul className="list-inside list-disc text-amber-600 dark:text-amber-500">
          {result.warnings.map((wm) => (
            <li key={wm}>{wm}</li>
          ))}
        </ul>
      )}
      {result.errors && result.errors.length > 0 && (
        <ul className="list-inside list-disc text-destructive">
          {result.errors.slice(0, 20).map((em) => (
            <li key={em}>{em}</li>
          ))}
          {result.errors.length > 20 && <li>…共 {result.errors.length} 条错误</li>}
        </ul>
      )}
    </div>
  );
}

// ── 互联网测绘引擎（FOFA/Quake/Hunter/ZoomEye/Shodan/Censys）─────────────────

type EngineStatus = Record<string, { enabled: boolean; configured: boolean; base_url: string }>;

const ENGINE_META: { key: string; label: string; placeholder: string }[] = [
  { key: "fofa", label: "FOFA", placeholder: 'title="统一身份认证" && domain=".edu.cn"' },
  { key: "quake", label: "Quake", placeholder: "title:'统一身份认证' AND domain:.edu.cn" },
  { key: "hunter", label: "Hunter", placeholder: 'web.title="统一身份认证"' },
  { key: "zoomeye", label: "ZoomEye", placeholder: "title:'统一身份认证' +site:.edu.cn" },
  { key: "shodan", label: "Shodan", placeholder: "http.title:'unified auth'" },
  { key: "censys", label: "Censys", placeholder: "web.body:'unified auth'" },
];

function EnginesPanel() {
  const [status, setStatus] = React.useState<{ engines: EngineStatus; llm_ready: boolean } | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    api
      .enginesStatus()
      .then(setStatus)
      .catch((e) => toast.error(`读取引擎状态失败：${e.message}`))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <PlugZapIcon className="size-4" /> 引擎配置
            {status && !status.llm_ready && (
              <Badge variant="outline">LLM 未配置 · 仅支持查询语法</Badge>
            )}
          </CardTitle>
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCwIcon className={loading ? "size-4 animate-spin" : "size-4"} /> 刷新
          </Button>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground mb-3 text-sm">
            填好 Key 并启用后即可搜索。查询按所选引擎官网语法原样请求；也可切到大白话意图，由 LLM 转写为语法。
          </p>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {ENGINE_META.map((m) => (
              <EngineCard
                key={m.key}
                meta={m}
                st={status?.engines?.[m.key]}
                onChanged={load}
              />
            ))}
          </div>
        </CardContent>
      </Card>
      <EnginesWorkbench status={status} />
    </div>
  );
}

function EngineCard({
  meta,
  st,
  onChanged,
}: {
  meta: { key: string; label: string; placeholder: string };
  st?: { enabled: boolean; configured: boolean; base_url: string };
  onChanged: () => void;
}) {
  const [key, setKey] = React.useState("");
  const [baseUrl, setBaseUrl] = React.useState("");
  const [enabled, setEnabled] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (st) {
      setBaseUrl(st.base_url ?? "");
      setEnabled(st.enabled);
    }
  }, [st]);

  const save = async () => {
    setBusy(true);
    try {
      await api.enginesDatasource({
        engine: meta.key,
        key: key.trim() || undefined,
        base_url: baseUrl.trim() || undefined,
        enabled: enabled,
      });
      toast.success(`${meta.label} 已保存`);
      setKey("");
      onChanged();
    } catch (e) {
      toast.error(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">{meta.label}</span>
        {st?.configured ? (
          <Badge className="bg-emerald-600 hover:bg-emerald-600">已配置</Badge>
        ) : (
          <Badge variant="outline">未配置</Badge>
        )}
      </div>
      <Input
        type="password"
        placeholder="API Key（留空保留原值）"
        value={key}
        onChange={(e) => setKey(e.target.value)}
      />
      <Input
        placeholder="自定义端点（可选）"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <div className="flex items-center justify-between">
        <label htmlFor={`en-${meta.key}`} className="flex items-center gap-1.5 text-sm">
          <Checkbox
            id={`en-${meta.key}`}
            checked={enabled}
            onCheckedChange={(c) => setEnabled(!!c)}
          />
          启用
        </label>
        <Button size="sm" variant="outline" onClick={save} disabled={busy}>
          保存
        </Button>
      </div>
    </div>
  );
}

function EnginesWorkbench({
  status,
}: {
  status: { engines: EngineStatus; llm_ready: boolean } | null;
}) {
  const [engine, setEngine] = React.useState("fofa");
  const [mode, setMode] = React.useState<"syntax" | "intent">("syntax");
  const [query, setQuery] = React.useState("");
  const [maxPages, setMaxPages] = React.useState(5);
  const [createCompany, setCreateCompany] = React.useState(true);

  const [preview, setPreview] = React.useState<EngineAsset[]>([]);
  const [resolvedQuery, setResolvedQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [result, setResult] = React.useState<Awaited<ReturnType<typeof api.enginesSync>> | null>(null);

  const meta = ENGINE_META.find((m) => m.key === engine) ?? ENGINE_META[0];
  const configured = !!status?.engines?.[engine]?.configured && !!status?.engines?.[engine]?.enabled;

  const doSearch = async () => {
    if (!query.trim()) return toast.error("请输入查询内容");
    setSearching(true);
    setPreview([]);
    try {
      const r = await api.enginesSearch({ engine, query: query.trim(), intent: mode === "intent", page: 1, size: 50 });
      setResolvedQuery(r.query);
      setPreview(r.page.assets ?? []);
      toast.success(`预览返回 ${(r.page.assets ?? []).length} 条`);
    } catch (e) {
      toast.error(`搜索失败：${(e as Error).message}`);
    } finally {
      setSearching(false);
    }
  };

  const doSync = async () => {
    if (!query.trim()) return toast.error("请输入查询内容");
    setSyncing(true);
    setResult(null);
    try {
      const r = await api.enginesSync({
        engine,
        query: query.trim(),
        intent: mode === "intent",
        max_pages: maxPages,
        create_company: createCompany,
      });
      setResult(r);
      const total = Object.values(r.synced ?? {}).reduce((a, b) => a + b, 0);
      toast.success(`同步完成，共入库 ${total} 条`);
    } catch (e) {
      toast.error(`同步失败：${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">测绘搜资产</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {ENGINE_META.map((m) => (
            <Button
              key={m.key}
              size="sm"
              variant={engine === m.key ? "default" : "outline"}
              onClick={() => setEngine(m.key)}
            >
              {m.label}
              {status?.engines?.[m.key]?.configured ? "" : " *"}
            </Button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Button size="sm" variant={mode === "syntax" ? "default" : "outline"} onClick={() => setMode("syntax")}>
            查询语法
          </Button>
          <Button
            size="sm"
            variant={mode === "intent" ? "default" : "outline"}
            onClick={() => {
              if (!status?.llm_ready) return toast.error("LLM 未配置，无法使用意图模式");
              setMode("intent");
            }}
          >
            大白话意图（LLM 转写）
          </Button>
        </div>

        <textarea
          className="min-h-[72px] w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          rows={3}
          placeholder={mode === "syntax" ? meta.placeholder : "例：帮我找教育行业的统一身份认证登录页"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm">
            最大翻页数
            <Input
              type="number"
              min={1}
              max={100}
              value={maxPages}
              onChange={(e) => setMaxPages(Math.max(1, Number(e.target.value) || 1))}
              className="w-20"
            />
          </label>
          <label htmlFor="eng-company" className="flex items-center gap-1.5 text-sm">
            <Checkbox id="eng-company" checked={createCompany} onCheckedChange={(c) => setCreateCompany(!!c)} />
            按主域建立企业并写入范围
          </label>
          <div className="flex-1" />
          {!configured && <span className="text-amber-600 text-xs dark:text-amber-500">* 当前引擎未配置/未启用</span>}
          <Button variant="outline" onClick={doSearch} disabled={searching || !configured}>
            <SearchIcon className={searching ? "size-4 animate-pulse" : "size-4"} /> 预览搜索
          </Button>
          <Button onClick={doSync} disabled={syncing || !configured}>
            <DownloadIcon className={syncing ? "size-4 animate-pulse" : "size-4"} /> 拉取并入库
          </Button>
        </div>

        {resolvedQuery && (
          <p className="text-muted-foreground text-xs">
            实际查询语法：<code>{resolvedQuery}</code>
          </p>
        )}

        {preview.length > 0 && (
          <div className="max-h-72 overflow-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>主机</TableHead>
                  <TableHead>IP:端口</TableHead>
                  <TableHead>标题</TableHead>
                  <TableHead>组织</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.map((a, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-medium">{a.host || a.ip}</TableCell>
                    <TableCell>{a.ip ? `${a.ip}:${a.port || ""}` : "—"}</TableCell>
                    <TableCell className="max-w-48 truncate">{a.title || "—"}</TableCell>
                    <TableCell>{a.org || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {result && <SyncResult result={result} />}
      </CardContent>
    </Card>
  );
}
