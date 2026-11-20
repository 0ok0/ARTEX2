"use client";

import * as React from "react";

import { ChevronRightIcon, Loader2Icon, PaperclipIcon, PencilIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";

import { AssetInterceptRulesEditor } from "@/components/asset-intercept-rules-editor";
import { TaskLLMProfileChain } from "@/components/task-llm-profile-chain";
import { TaskTemplateControls } from "@/components/task-template-controls";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
} from "@/components/ui/combobox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { AssetInterceptRuleInput, ChatAttachment, Company, LLMProfile, Task, TaskCategory } from "@/lib/types";

const MAX_SOURCE_TASKS = 8;
// UPLOAD_MARKER labels the auto-appended block of uploaded-file paths inside the task
// description, so re-uploads append under the same block instead of adding a new header.
const UPLOAD_MARKER = "【上传文件（绝对路径）】";

function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

// appendUploads folds newly-uploaded files' ABSOLUTE paths into the description as a
// Read/Bash-friendly manifest — the worker opens them by path. Keeps one marked block:
// first upload adds the header, later uploads append bullets under it.
function appendUploads(desc: string, atts: ChatAttachment[]): string {
  const bullets = atts.map((a) => `- ${a.abs ?? a.path}（${fmtBytes(a.size)}）`).join("\n");
  if (desc.includes(UPLOAD_MARKER)) {
    return `${desc.replace(/\s*$/, "")}\n${bullets}\n`;
  }
  const head = desc.trim() ? `${desc.replace(/\s*$/, "")}\n\n` : "";
  return `${head}${UPLOAD_MARKER} worker 可用 Read/Bash 按路径打开：\n${bullets}\n`;
}

// toLocalInput converts an RFC3339 timestamp into a datetime-local input value
// (本地时区的 yyyy-MM-ddTHH:mm；空值返回空串)。
function toLocalInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function SourceTaskPicker({
  tasks,
  value,
  onValueChange,
  portalContainer,
}: {
  tasks: Task[];
  value: string[];
  onValueChange: (value: string[]) => void;
  portalContainer?: React.RefObject<HTMLElement | null>;
}) {
  const tasksByID = React.useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const taskIDs = React.useMemo(() => tasks.map((task) => task.id), [tasks]);
  const atLimit = value.length >= MAX_SOURCE_TASKS;

  const handleValueChange = (next: string[]) => {
    onValueChange(next.slice(0, MAX_SOURCE_TASKS));
  };

  return (
    <Combobox
      items={taskIDs}
      itemToStringValue={(taskID) => {
        const task = tasksByID.get(taskID);
        return task ? `${task.id} ${task.description} ${task.goal}` : taskID;
      }}
      multiple
      value={value}
      onValueChange={handleValueChange}
    >
      <ComboboxChips>
        <ComboboxValue>
          {value.map((taskID) => (
            <ComboboxChip key={taskID}>#{taskID}</ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput
          id="source-tasks"
          placeholder={atLimit ? `最多关联 ${MAX_SOURCE_TASKS} 个任务` : "搜索任务 ID、描述或目标"}
          disabled={atLimit}
        />
      </ComboboxChips>
      <ComboboxContent portalContainer={portalContainer}>
        <ComboboxEmpty>没有匹配的任务</ComboboxEmpty>
        <ComboboxList>
          {(taskID) => {
            const task = tasksByID.get(taskID);
            return (
              <ComboboxItem key={taskID} value={taskID} disabled={atLimit && !value.includes(taskID)}>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      #{taskID} · {task?.description ?? "未知任务"}
                    </p>
                    {task?.goal && <p className="text-muted-foreground truncate text-xs">{task.goal}</p>}
                  </div>
                  {task && <span className="text-muted-foreground shrink-0 text-xs">{task.status}</span>}
                </div>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

// CategoryPicker 是单选分类选择器：可搜索已有分类；输入库里没有的名称后
// 回车（或点下拉里的「创建」）即时新建分类并选中，选中项以可移除的 tag 展示。分类是
// 全局资源，这里即时创建与「分类管理」里手动新建等价。只允许一个分类。
function CategoryPicker({
  categories,
  value,
  onValueChange,
  onCategoryCreated,
  portalContainer,
}: {
  categories: TaskCategory[];
  value?: number;
  onValueChange: (categoryID?: number) => void;
  onCategoryCreated: () => void;
  portalContainer?: React.RefObject<HTMLElement | null>;
}) {
  const [inputValue, setInputValue] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  // 新建的分类要等父层重新拉取才回流到 categories，先本地留一份，避免选中的 chip 和
  // 下拉在这段窗口里显示成「未知分类」。
  const [localExtra, setLocalExtra] = React.useState<TaskCategory[]>([]);

  const allCategories = React.useMemo(() => {
    const byID = new Map<number, TaskCategory>();
    for (const category of categories) byID.set(category.id, category);
    for (const category of localExtra) if (!byID.has(category.id)) byID.set(category.id, category);
    return [...byID.values()];
  }, [categories, localExtra]);

  const byID = React.useMemo(() => new Map(allCategories.map((c) => [String(c.id), c])), [allCategories]);
  const categoryIDs = React.useMemo(() => allCategories.map((c) => String(c.id)), [allCategories]);
  const selectedIDs = value != null ? [String(value)] : [];

  const trimmed = inputValue.trim();
  const lower = trimmed.toLowerCase();
  // 与 base-ui 默认子串过滤保持一致，用来判断「有没有相关分类」。
  const matchCount = trimmed
    ? allCategories.filter((c) => c.name.toLowerCase().includes(lower)).length
    : allCategories.length;

  const createAndSelect = async () => {
    if (!trimmed || creating) return;
    // 精确同名已存在则直接选中，不重复创建。
    const existing = allCategories.find((c) => c.name.toLowerCase() === lower);
    if (existing) {
      onValueChange(existing.id);
      setInputValue("");
      return;
    }
    setCreating(true);
    try {
      const created = await api.createTaskCategory(trimmed);
      setLocalExtra((prev) => [...prev, created]);
      onValueChange(created.id);
      setInputValue("");
      onCategoryCreated();
      toast.success(`已创建分类「${created.name}」`);
    } catch (e) {
      toast.error(`创建分类失败：${(e as Error).message}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Combobox
      items={categoryIDs}
      itemToStringValue={(id) => byID.get(id)?.name ?? id}
      multiple
      value={selectedIDs}
      onValueChange={(next: string[]) => {
        // 单选：取最新选中的一个；移除 chip（清空）则回到未分类。
        const last = next[next.length - 1];
        onValueChange(last ? Number(last) : undefined);
        setInputValue("");
      }}
      inputValue={inputValue}
      onInputValueChange={setInputValue}
    >
      <ComboboxChips>
        <ComboboxValue>
          {selectedIDs.map((id) => (
            <ComboboxChip key={id}>{byID.get(id)?.name ?? "未知分类"}</ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput
          id="task-category"
          placeholder={selectedIDs.length ? "" : "搜索分类，或输入新名称后回车创建"}
          onKeyDown={(e) => {
            // 完全无匹配时回车 = 创建；有匹配项时保留 base-ui 的「回车选中高亮项」。
            if (e.key === "Enter" && matchCount === 0 && trimmed) {
              e.preventDefault();
              void createAndSelect();
            }
          }}
        />
      </ComboboxChips>
      <ComboboxContent portalContainer={portalContainer}>
        <ComboboxList>
          {(id: string) => (
            <ComboboxItem key={id} value={id}>
              {byID.get(id)?.name ?? id}
            </ComboboxItem>
          )}
        </ComboboxList>
        {matchCount === 0 &&
          (trimmed ? (
            <button
              type="button"
              disabled={creating}
              onClick={() => void createAndSelect()}
              className="flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              {creating ? <Spinner className="size-4" /> : <PlusIcon className="size-4" />}
              创建分类「{trimmed}」
            </button>
          ) : (
            <div className="px-2 py-2 text-sm text-muted-foreground">输入名称以搜索或创建分类</div>
          ))}
      </ComboboxContent>
    </Combobox>
  );
}

const COMPANY_SCOPE_LABELS: Record<string, string> = {
  domain: "域名",
  ip: "IP",
  cidr: "CIDR",
  icp: "ICP",
  keyword: "关键词",
};

function companyScopeSummary(company: Company): string {
  const rows = company.scope ?? [];
  if (rows.length === 0) return "未配置资产范围";
  const preview = rows.slice(0, 3).map((row) => {
    const value = row.raw || row.value || row.domain || row.net || "";
    return `${COMPANY_SCOPE_LABELS[row.kind] ?? row.kind}：${value}`;
  });
  return `${preview.join(" · ")}${rows.length > preview.length ? ` · 另 ${rows.length - preview.length} 条` : ""}`;
}

function CompanyPicker({
  companies,
  value,
  onValueChange,
  portalContainer,
}: {
  companies: Company[];
  value: number[];
  onValueChange: (value: number[]) => void;
  portalContainer?: React.RefObject<HTMLElement | null>;
}) {
  const companiesByID = React.useMemo(
    () => new Map(companies.map((company) => [String(company.id), company])),
    [companies],
  );
  const companyIDs = React.useMemo(() => companies.map((company) => String(company.id)), [companies]);
  const selectedIDs = React.useMemo(() => value.map(String), [value]);

  return (
    <Combobox
      items={companyIDs}
      itemToStringValue={(companyID) => {
        const company = companiesByID.get(companyID);
        return company ? `${company.name} ${companyScopeSummary(company)}` : companyID;
      }}
      multiple
      value={selectedIDs}
      onValueChange={(next) => onValueChange(next.map(Number).filter(Number.isFinite))}
    >
      <ComboboxChips>
        <ComboboxValue>
          {selectedIDs.map((companyID) => (
            <ComboboxChip key={companyID}>{companiesByID.get(companyID)?.name ?? `企业 #${companyID}`}</ComboboxChip>
          ))}
        </ComboboxValue>
        <ComboboxChipsInput id="task-companies" placeholder="搜索企业名称或资产范围" disabled />
      </ComboboxChips>
      <ComboboxContent portalContainer={portalContainer}>
        <ComboboxEmpty>没有匹配的企业</ComboboxEmpty>
        <ComboboxList>
          {(companyID) => {
            const company = companiesByID.get(companyID);
            return (
              <ComboboxItem key={companyID} value={companyID}>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{company?.name ?? `企业 #${companyID}`}</span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {company?.asset_count ?? 0} 个资产
                    </span>
                  </div>
                  {company && (
                    <span className="text-muted-foreground truncate text-xs" title={companyScopeSummary(company)}>
                      {companyScopeSummary(company)}
                    </span>
                  )}
                </div>
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

// TaskEditButton 是列表行通用的编辑入口：只负责通知调用方打开编辑抽屉（编辑表单由
// 调用方以 edit 模式挂载 TaskFormSheet，行内不再各自持有一份表单）。
export function TaskEditButton({ task, onEdit }: { task: Task; onEdit: (task: Task) => void }) {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label="编辑任务"
      title="编辑任务"
      onClick={(e) => {
        e.stopPropagation();
        onEdit(task);
      }}
    >
      <PencilIcon />
    </Button>
  );
}

export interface TaskFormSheetProps {
  mode: "create" | "edit";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** mode="edit" 时必填：要编辑的任务。 */
  editTask?: Task | null;
  /** 保存/创建成功后回调（调用方刷新列表/详情）。 */
  onSaved?: () => void;
  /** 分类发生变化（新建分类）后回调。 */
  onCategoriesChanged?: () => void;
}

// TaskFormSheet 是新建/编辑任务共用的右侧抽屉。编辑模式复用创建表单的全部字段与布局：
// 描述/目标/关联任务按状态锁定（running/paused 的执行上下文已形成）；关联企业不可编辑
// （创建时确定——关联牵动资产归属同步，编辑替换风险大）；拦截规则请到任务详情的
// 「拦截规则」tab 管理（那里有完整 CRUD）。form state 住在组件内，打字只重渲染抽屉。
export function TaskFormSheet({
  mode,
  open,
  onOpenChange,
  editTask,
  onSaved,
  onCategoriesChanged,
}: TaskFormSheetProps) {
  const isEdit = mode === "edit";
  const task = isEdit ? (editTask ?? null) : null;
  const coreLocked = isEdit && (task?.status === "running" || task?.status === "paused");
  const isCreatedTask = isEdit && task?.status === "created";

  const sheetContentRef = React.useRef<HTMLDivElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const draftIdRef = React.useRef<string>("");

  const [name, setName] = React.useState("");
  const [categoryID, setCategoryID] = React.useState<number | undefined>(undefined);
  const [description, setDescription] = React.useState("");
  const [goal, setGoal] = React.useState("");
  const [selectedTemplateID, setSelectedTemplateID] = React.useState<number | null>(null);
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  const [companies, setCompanies] = React.useState<Company[]>([]);
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [sourceTaskIDs, setSourceTaskIDs] = React.useState<string[]>([]);
  const [companyIDs] = React.useState<number[]>([]);
  const [llmProfileIDs, setLLMProfileIDs] = React.useState<string[]>([]);
  const [saving, setSaving] = React.useState(false);
  const [timeoutMin, setTimeoutMin] = React.useState("");
  const [heartbeatMin, setHeartbeatMin] = React.useState("10");
  const [runMode, setRunMode] = React.useState<"immediate" | "never" | "scheduled">("immediate");
  const [scheduledAt, setScheduledAt] = React.useState("");
  const [seedFirstIntent, setSeedFirstIntent] = React.useState(false);
  const [coverageEnabled, setCoverageEnabled] = React.useState(true);
  const [interceptRules, setInterceptRules] = React.useState<AssetInterceptRuleInput[]>([]);
  // 测绘搜资产：创建任务前先用测绘引擎拉一批资产入库，并按主域建企业/范围。
  const [reconEngine, setReconEngine] = React.useState("");
  const [reconQuery, setReconQuery] = React.useState("");
  const [reconIntent, setReconIntent] = React.useState(false);
  const [reconMaxPages, setReconMaxPages] = React.useState(3);
  const [reconSyncing, setReconSyncing] = React.useState(false);
  const [reconResult, setReconResult] = React.useState<{ total: number; companies: string[] } | null>(null);
  const [reconCompanies, setReconCompanies] = React.useState<number[]>([]);
  const [uploading, setUploading] = React.useState(false);
  const [uploadCount, setUploadCount] = React.useState(0);

  // edit 模式：打开时从任务预填。create 模式打开时清空（复用同一实例的残留 state）。
  React.useEffect(() => {
    if (!open) return;
    if (isEdit && task) {
      setName(task.name ?? "");
      setCategoryID(task.category_id);
      setDescription(task.description ?? "");
      setGoal(task.goal ?? "");
      setSourceTaskIDs([...(task.source_task_ids ?? [])]);
      setLLMProfileIDs((task.llm_profile_ids ?? []).map(String));
      setTimeoutMin(task.timeout_seconds ? String(Math.round(task.timeout_seconds / 60)) : "");
      setHeartbeatMin(task.plan_heartbeat_seconds ? String(Math.round(task.plan_heartbeat_seconds / 60)) : "10");
      setCoverageEnabled(task.coverage_enabled ?? true);
      const scheduled = isCreatedTask && task.scheduled_at ? "scheduled" : "immediate";
      setRunMode(scheduled);
      setScheduledAt(toLocalInput(task.scheduled_at));
    } else if (!isEdit) {
      setName("");
      setCategoryID(undefined);
      setDescription("");
      setGoal("");
      setSelectedTemplateID(null);
      setSourceTaskIDs([]);
      setLLMProfileIDs([]);
      setTimeoutMin("");
      setHeartbeatMin("10");
      setRunMode("immediate");
      setScheduledAt("");
      setSeedFirstIntent(false);
      setCoverageEnabled(true);
      setInterceptRules([]);
      setUploadCount(0);
      draftIdRef.current = "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, editTask?.id]);

  // 数据自加载：不依赖调用方传入列表，列表页/详情页都能直接用。
  const [categories, setCategories] = React.useState<TaskCategory[]>([]);
  React.useEffect(() => {
    if (!open) return;
    api
      .llmProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
    api
      .companies()
      .then(setCompanies)
      .catch(() => setCompanies([]));
    api
      .tasks()
      .then((r) => setTasks(r.tasks))
      .catch(() => setTasks([]));
    api
      .taskCategories()
      .then(setCategories)
      .catch(() => setCategories([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // pickFiles uploads the chosen files into this draft's staging dir and appends their
  // absolute paths to the description; the task's agents open them by path via Read/Bash.
  async function pickFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (!draftIdRef.current) {
      draftIdRef.current =
        globalThis.crypto?.randomUUID?.() ?? `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }
    setUploading(true);
    try {
      const r = await api.chatUpload("staging", draftIdRef.current, Array.from(files));
      setDescription((prev) => appendUploads(prev, r.attachments));
      setUploadCount((n) => n + r.attachments.length);
    } catch (e) {
      toast.error("上传失败：" + (e as Error).message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = ""; // allow re-picking the same file
    }
  }

  // runRecon 在建任务前调测绘引擎拉资产入库；返回后刷新企业列表并自动勾选新建企业。
  async function runRecon() {
    if (!reconEngine || !reconQuery.trim()) {
      toast.error("请选择引擎并填写查询内容");
      return;
    }
    setReconSyncing(true);
    setReconResult(null);
    try {
      const r = await api.enginesSync({
        engine: reconEngine,
        query: reconQuery.trim(),
        intent: reconIntent,
        max_pages: reconMaxPages,
        create_company: true,
      });
      const total = Object.entries(r.synced ?? {})
        .filter(([k]) => k !== "skipped")
        .reduce((a, [, b]) => a + b, 0);
      setReconResult({ total, companies: r.companies ?? [] });
      const before = new Set(companies.map((c) => c.id));
      try {
        const fresh = await api.companies();
        setCompanies(fresh);
        const newIds = fresh.filter((c) => !before.has(c.id)).map((c) => c.id);
        if (newIds.length > 0) setReconCompanies((prev) => [...new Set([...prev, ...newIds])]);
      } catch {
        /* 企业刷新失败不影响主流程 */
      }
      toast.success(`测绘入库 ${total} 条资产`);
    } catch (e) {
      toast.error(`测绘失败：${(e as Error).message}`);
    } finally {
      setReconSyncing(false);
    }
  }

  async function submit() {
    if (!description.trim() || !goal.trim()) {
      toast.error("请填写描述与目标");
      return;
    }
    if (sourceTaskIDs.length > MAX_SOURCE_TASKS) {
      toast.error(`最多关联 ${MAX_SOURCE_TASKS} 个来源任务`);
      return;
    }
    let scheduledRFC: string | undefined;
    if (!isEdit && runMode === "scheduled") {
      if (!scheduledAt) {
        toast.error("请选择计划执行时间");
        return;
      }
      const ts = new Date(scheduledAt).getTime();
      if (!Number.isFinite(ts) || ts <= Date.now()) {
        toast.error("计划时间必须晚于当前时刻");
        return;
      }
      scheduledRFC = new Date(scheduledAt).toISOString();
    }
    // 编辑模式的计划值：scheduled→新时间；否则空串=取消排程（仅 created 任务会提交该字段）。
    let editScheduledRFC: string | undefined;
    if (isEdit && isCreatedTask) {
      editScheduledRFC = runMode === "scheduled" && scheduledAt ? new Date(scheduledAt).toISOString() : "";
    }
    let createSuccessTip = "任务已创建";
    if (runMode === "never") {
      createSuccessTip = "任务已创建（暂不执行），可在任务列表点击 ▶ 启动";
    } else if (runMode === "scheduled") {
      createSuccessTip = "任务已创建，到达计划时间将自动启动";
    }
    setSaving(true);
    try {
      if (isEdit && task) {
        // 编辑：核心字段 + 关联任务 + 执行计划走 PUT /edit；LLM 链有变化单独走既有 API。
        await api.editTask(task.id, {
          name: name.trim(),
          description: description.trim(),
          goal: goal.trim(),
          categoryId: categoryID,
          timeoutSeconds: Math.max(0, Math.floor(Number(timeoutMin) || 0)) * 60,
          planHeartbeatSeconds: Math.max(10, Math.floor(Number(heartbeatMin) || 10)) * 60,
          coverageEnabled,
          sourceTaskIds: coreLocked ? undefined : sourceTaskIDs,
          scheduledAt: editScheduledRFC,
        });
        const original = task.llm_profile_ids ?? [];
        const next = llmProfileIDs.map(Number);
        const changed = original.length !== next.length || original.some((v, i) => v !== next[i]);
        if (changed) {
          await api.updateTaskLLMProfiles(task.id, next);
        }
        let editSuccessTip = `任务 #${task.id} 已保存`;
        if (task.status === "created") {
          editSuccessTip = `任务 #${task.id} 已保存；可点 ▶ 按新内容启动`;
        } else if (task.status === "done" || task.status === "failed" || task.status === "timeout") {
          editSuccessTip = `任务 #${task.id} 已保存；可点 ⟳ 重新进行按新内容重跑`;
        }
        toast.success(editSuccessTip);
      } else {
        // 创建：完整建后流程由后端决定（立即/暂不/定时）。
        await api.createTask({
          name: name.trim(),
          categoryId: categoryID,
          description: description.trim(),
          goal: goal.trim(),
          llmProfileIds: llmProfileIDs.map(Number),
          sourceTaskIds: sourceTaskIDs,
          companyIds: [...new Set([...companyIDs, ...reconCompanies])],
          timeoutSeconds: Math.max(0, Math.floor(Number(timeoutMin) || 0)) * 60,
          seedFirstIntent,
          planHeartbeatSeconds: Math.max(10, Math.floor(Number(heartbeatMin) || 10)) * 60,
          coverageEnabled,
          runMode,
          scheduledAt: scheduledRFC,
          interceptRules: interceptRules
            .map((r) => ({ ...r, pattern: r.pattern.trim() }))
            .filter((r) => r.pattern !== ""),
        });
        toast.success(createSuccessTip);
      }
      onOpenChange(false);
      onSaved?.();
    } catch (e) {
      toast.error(`${isEdit ? "保存" : "创建"}失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  const title = isEdit ? `编辑任务 #${task?.id ?? ""}` : "新建任务";

  let submitLabel = isEdit ? "保存" : "创建";
  if (saving) submitLabel = isEdit ? "保存中" : "创建中";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* 45vw 宽的右侧抽屉:整屏高度可滚动,长表单不再受弹窗高度限制。窄屏退化为全宽。
          内容为 flex 列:头/脚固定,中间字段区 flex-1 独立滚动。 */}
      <SheetContent
        ref={sheetContentRef}
        side="right"
        className="w-full! max-w-none! gap-0 p-0 sm:w-[45vw]! sm:max-w-[45vw]!"
      >
        <SheetHeader className="border-b p-6">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {isEdit
              ? "与创建表单同构。描述/目标/关联任务按任务状态锁定；保存后按状态提示后续操作。"
              : "填写测试对象与目标，高级参数可按需展开。"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid gap-5">
            {!isEdit && (
              <TaskTemplateControls
                description={description}
                goal={goal}
                categoryID={categoryID}
                interceptRules={interceptRules}
                selectedTemplateID={selectedTemplateID}
                onSelectedTemplateIDChange={setSelectedTemplateID}
                onApply={(template) => {
                  setDescription(template.description);
                  setGoal(template.goal);
                  setCategoryID(template.category_id ?? undefined);
                  setInterceptRules(template.intercept_rules ?? []);
                  setUploadCount(0);
                }}
                portalContainer={sheetContentRef}
              />
            )}
            <div className="grid gap-2">
              <Label htmlFor="name">名称（可选）</Label>
              <Input
                id="name"
                placeholder="给任务起个便于识别的名字，例如：Acme 官网渗透"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Field>
              <FieldLabel htmlFor="task-category">任务分类</FieldLabel>
              <CategoryPicker
                categories={categories}
                value={categoryID}
                onValueChange={setCategoryID}
                onCategoryCreated={() => onCategoriesChanged?.()}
                portalContainer={sheetContentRef}
              />
              <FieldDescription>可选，单个分类；用于任务列表筛选和归档，不影响 Agent 执行。</FieldDescription>
            </Field>
            <div className="grid gap-2">
              <Label htmlFor="description">描述</Label>
              <Textarea
                id="description"
                className="min-h-32"
                placeholder="测试对象与背景，例如：测试 example.com 这个站点"
                value={description}
                disabled={coreLocked}
                onChange={(e) => setDescription(e.target.value)}
              />
              {!isEdit && (
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => void pickFiles(e.target.files)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                  >
                    {uploading ? <Loader2Icon className="animate-spin" /> : <PaperclipIcon />}
                    上传文件
                  </Button>
                  <span className="text-muted-foreground text-xs">
                    {uploadCount > 0
                      ? `已上传 ${uploadCount} 个文件，绝对路径已追加到描述末尾（可编辑）`
                      : "可多选；上传后把文件的绝对路径追加到描述，供 worker 用 Read/Bash 打开"}
                  </span>
                </div>
              )}
              {coreLocked && (
                <p className="text-muted-foreground text-xs">
                  运行中/已暂停的任务描述锁定；运行中调整目标请到任务详情的「目标管理」。
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="goal">目标</Label>
              <Textarea
                id="goal"
                className="min-h-32"
                placeholder="要达成什么，例如：拿下后台管理权限、获取服务器权限"
                value={goal}
                disabled={coreLocked}
                onChange={(e) => setGoal(e.target.value)}
              />
            </div>
            <Field>
              <FieldLabel htmlFor="source-tasks">关联任务</FieldLabel>
              <SourceTaskPicker
                tasks={tasks}
                value={sourceTaskIDs}
                onValueChange={setSourceTaskIDs}
                portalContainer={sheetContentRef}
              />
              <FieldDescription>
                {coreLocked
                  ? "运行中/已暂停的任务不能修改关联任务。"
                  : `最多关联 ${MAX_SOURCE_TASKS} 个任务。实时只读继承所选任务的持久化黑板、资产范围及相关流量；新任务写入独立黑板。`}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="task-companies">关联企业资产范围</FieldLabel>
              <CompanyPicker
                companies={companies}
                value={task?.company_ids ?? []}
                onValueChange={() => {
                  /* 编辑模式只读：关联企业创建时确定，替换牵动资产归属同步 */
                }}
                portalContainer={sheetContentRef}
              />
              <FieldDescription>
                {isEdit
                  ? "关联企业在创建时确定，不支持编辑替换（关联牵动资产归属同步）。如需调整范围请重建任务。"
                  : "创建任务时会将所选企业当前已有资产加入“测试资产”，并将域名、IP、CIDR、ICP 和企业关键词提供给 Agent 作为范围上下文；不会自动生成意图或强制改变执行目标。"}
              </FieldDescription>
            </Field>
            {!isEdit && (
              <Field>
                <FieldLabel>测绘搜资产（可选）</FieldLabel>
                <div className="space-y-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      className="h-9 rounded-md border bg-transparent px-2 text-sm"
                      value={reconEngine}
                      onChange={(e) => setReconEngine(e.target.value)}
                    >
                      <option value="">选择引擎…</option>
                      <option value="fofa">FOFA</option>
                      <option value="quake">Quake</option>
                      <option value="hunter">Hunter</option>
                      <option value="zoomeye">ZoomEye</option>
                      <option value="shodan">Shodan</option>
                      <option value="censys">Censys</option>
                    </select>
                    <label className="flex items-center gap-1.5 text-xs" htmlFor="recon-intent">
                      <Checkbox id="recon-intent" checked={reconIntent} onCheckedChange={(v) => setReconIntent(!!v)} />
                      大白话意图（LLM 转写）
                    </label>
                    <label className="flex items-center gap-1.5 text-xs" htmlFor="recon-max-pages">
                      翻页
                      <Input
                        id="recon-max-pages"
                        type="number"
                        min={1}
                        max={100}
                        value={reconMaxPages}
                        onChange={(e) => setReconMaxPages(Math.max(1, Number(e.target.value) || 1))}
                        className="h-8 w-16"
                      />
                    </label>
                    <div className="flex-1" />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void runRecon()}
                      disabled={reconSyncing || !reconEngine}
                    >
                      {reconSyncing ? "拉取中…" : "拉取资产"}
                    </Button>
                  </div>
                  <Input
                    placeholder={
                      reconIntent
                        ? "大白话需求，例：教育行业的统一身份认证登录页"
                        : '查询语法，例：title="统一身份认证" && domain=".edu.cn"'
                    }
                    value={reconQuery}
                    onChange={(e) => setReconQuery(e.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    拉取的资产直接入库并按主域建立企业，新建企业自动勾选进上方「关联企业资产范围」，任务范围即刻覆盖搜到的资产。
                    引擎 Key 在「资产同步 → 测绘引擎」页配置。
                  </p>
                  {reconResult && (
                    <p className="text-xs">
                      已入库 <b>{reconResult.total}</b> 条资产
                      {reconResult.companies.length > 0 && `；企业：${reconResult.companies.join("、")}`}
                    </p>
                  )}
                </div>
              </Field>
            )}
            {!isEdit && (
              <Field>
                <FieldLabel htmlFor="task-intercept-rules">任务级资产拦截 / 允许规则（可选）</FieldLabel>
                <AssetInterceptRulesEditor value={interceptRules} onChange={setInterceptRules} />
                <FieldDescription>
                  仅对本任务生效，不写入全局规则。判定顺序：先按「拦截」规则（含全局）匹配，命中即禁止测试；未命中且本任务配置了「允许」规则时，须命中某条允许规则才放行，否则同样不允许测试；未配置任何允许规则则不启用白名单。
                </FieldDescription>
              </Field>
            )}
            {isEdit && (
              <Field>
                <FieldLabel>任务级资产拦截 / 允许规则</FieldLabel>
                <FieldDescription>
                  在任务详情页的「拦截规则」tab 中管理（支持逐条增删改与启停），此处不重复提供。
                </FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="llm-profiles">LLM 配置链</FieldLabel>
              <TaskLLMProfileChain
                profiles={profiles}
                value={llmProfileIDs}
                onValueChange={setLLMProfileIDs}
                inputId="llm-profiles"
                portalContainer={sheetContentRef}
              />
              <FieldDescription>按列表顺序故障转移；第一项为当前配置，仅在明确额度不足时切换下一项。</FieldDescription>
            </Field>

            {/* 执行方式：创建时三选；编辑时仅未启动任务可调整定时计划。 */}
            {(!isEdit || isCreatedTask) && (
              <div className="grid gap-2">
                <Label>执行方式</Label>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      { value: "immediate", label: "立即执行", hint: "创建即启动（默认）" },
                      { value: "never", label: "暂不执行", hint: "仅创建，之后在任务列表手动启动" },
                      { value: "scheduled", label: "定时执行", hint: "到计划时间自动启动" },
                    ] as const
                  ).map((opt) => (
                    <Button
                      key={opt.value}
                      type="button"
                      size="sm"
                      variant={runMode === opt.value ? "default" : "outline"}
                      title={opt.hint}
                      onClick={() => setRunMode(opt.value)}
                    >
                      {opt.label}
                    </Button>
                  ))}
                </div>
                {runMode === "scheduled" && (
                  <div className="grid gap-1">
                    <Input
                      type="datetime-local"
                      className="w-56"
                      value={scheduledAt}
                      onChange={(e) => setScheduledAt(e.target.value)}
                    />
                    <p className="text-muted-foreground text-xs">
                      {isEdit
                        ? "修改计划后保存即生效（传空且选「立即/暂不」则取消排程）。"
                        : "到点由服务端自动启动（约 30 秒粒度）；已排程的任务可随时在列表里手动提前启动。"}
                    </p>
                  </div>
                )}
                {runMode === "never" && !isEdit && (
                  <p className="text-muted-foreground text-xs">
                    任务创建后停在「已创建」状态，不会消耗并发额度；在任务列表点 ▶ 启动。
                  </p>
                )}
              </div>
            )}

            {/* 高级参数默认折叠:超时/心跳/首个意图,展开才占空间,常用路径保持清爽。 */}
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-center gap-2 border-t pt-4 text-sm font-medium">
                <ChevronRightIcon className="text-muted-foreground size-4 transition-transform group-data-[state=open]:rotate-90" />
                高级设置
                <span className="text-muted-foreground ml-auto text-xs font-normal">
                  超时 · 心跳{!isEdit && " · 首个意图"}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-5 pt-5">
                <div className="grid gap-2">
                  <Label htmlFor="timeout-min">任务超时（分钟，可选）</Label>
                  <Input
                    id="timeout-min"
                    type="number"
                    min={0}
                    className="w-40"
                    placeholder="留空 = 不限时"
                    value={timeoutMin}
                    onChange={(e) => setTimeoutMin(e.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    到点后触发优雅收尾（各 agent 写回 + planner 终局判定），任务进入 timeout 终态。
                  </p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="heartbeat-min">planner 心跳（分钟）</Label>
                  <Input
                    id="heartbeat-min"
                    type="number"
                    min={10}
                    className="w-40"
                    placeholder="默认 10"
                    value={heartbeatMin}
                    onChange={(e) => setHeartbeatMin(e.target.value)}
                  />
                  <p className="text-muted-foreground text-xs">
                    距上轮规划结束/任务开始满该时长且期间无触发，自动触发一轮规划（兜底卡死 + 唤醒去监督在跑的
                    worker）。下限 10 分钟。
                  </p>
                </div>
                {!isEdit && (
                  <div className="grid gap-2">
                    <label htmlFor="seed-first-intent" className="flex items-center gap-2 text-sm">
                      <Checkbox
                        id="seed-first-intent"
                        checked={seedFirstIntent}
                        onCheckedChange={(v) => setSeedFirstIntent(!!v)}
                      />
                      直接下发首个意图（描述+目标）
                    </label>
                    <p className="text-muted-foreground text-xs">
                      开启后创建即把「描述+目标」作为一条意图下发，worker 免等首轮规划直接开跑，跑完再由 planner
                      接手判定/补充。CTF 等常一个 work 直接解决的场景推荐开启；关闭则走标准的先规划再执行。
                    </p>
                  </div>
                )}
                <div className="grid gap-2">
                  <label htmlFor="coverage-enabled" className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id="coverage-enabled"
                      checked={coverageEnabled}
                      onCheckedChange={(v) => setCoverageEnabled(!!v)}
                    />
                    资产覆盖度功能
                  </label>
                  <p className="text-muted-foreground text-xs">
                    默认开启：计算并展示测试覆盖度、态势图显示测试进度、自动累积测试范围。关闭后不再计算/展示覆盖度，
                    态势图仅展示资产不显示进度，agent 也不再获得范围类工具。关闭不影响「关联企业资产范围」。
                  </p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t p-4">
          <SheetClose asChild>
            <Button variant="outline">取消</Button>
          </SheetClose>
          <Button onClick={() => void submit()} disabled={saving || uploading}>
            {saving && <Spinner data-icon="inline-start" />}
            {submitLabel}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
