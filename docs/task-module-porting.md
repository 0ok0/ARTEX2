# 任务定时执行 / 编辑 / 重跑模块 — 移植指南

> 来源：ARTEX2（Go 1.27 + PostgreSQL + Next.js）。本文档描述该模块的完整结构、契约与移植步骤。
> 目标：在任何"任务 + 引擎"型 Go 服务里快速复刻这三个功能。

---

## 1. 功能概览

| 功能 | 行为 | 入口 |
|---|---|---|
| **定时执行** | 创建任务时选「立即执行 / 暂不执行 / 定时执行」；定时任务到点由服务端调度循环自动启动；重启后排程不丢 | 创建表单 + 30s 调度循环 |
| **任务编辑** | 创建后修改 name/description/goal/category/超时/心跳/覆盖度/关联任务/执行计划；按任务状态锁定字段 | 详情页 ✏️ / 列表行铅笔 → 编辑抽屉 |
| **重新进行（rerun）** | 终态(done/failed/timeout)任务复活：重置 met 目标为 open，保留图/资产/事实，planner 重新规划 | 列表行 ▶（终态）/ 详情页 ⟳ 按钮 |

## 2. 数据模型（最小 DB 变更）

仅 1 列，无新表：

```sql
-- schema.sql：tasks 表定义内加一列
scheduled_at TIMESTAMPTZ,
-- 对已有库的迁移（幂等）：
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
```

语义：`scheduled_at` 非空 **且** `status='created'`（未启动）＝等待到点自动启动。启动即清空。

## 3. 后端文件清单

### 3.1 db 层（db/tasks.go）

```go
// Task struct 增加字段
ScheduledAt *time.Time `json:"scheduled_at,omitempty"`

// taskCols / scanTask 增加列（SELECT 列清单 + Scan 顺序同步加 scheduled_at）

// 设置/清除排程（at=nil 清除）
func (d *DB) SetTaskScheduled(id int64, at *time.Time) error
// UPDATE tasks SET scheduled_at=$2, updated_at=now() WHERE id=$1

// 原子认领到期任务：防并发/重启后重复启动的关键
func (d *DB) ClaimDueScheduledTasks(now time.Time) ([]int64, error)
// UPDATE tasks SET scheduled_at=NULL, updated_at=now()
//  WHERE scheduled_at IS NOT NULL AND scheduled_at <= $1
//    AND status='created' AND deleted_at IS NULL
// RETURNING id
```

### 3.2 重跑需要（db/exploration.go，挂在任务图 Store 上）

```go
// 把 met 目标重置为 open——rerun 的语义核心。没有它，复活后 planner
// 立即判定「所有目标已达成」再次落 done（秒退）。
func (s *ExplorationStore) ResetMetGoals() (int64, error)
// UPDATE exploration_nodes SET state='open', updated_at=now()
//  WHERE exploration_id=$1 AND kind='goal' AND state='met'
```

### 3.3 manager 层（server/manager.go）

内存模型三处同步（Task 的可变字段全部走 lifecycle 快照模式）：

```go
type Task struct { ...; ScheduledAt int64 /* unix 秒, 0=无 */ }
type taskLifecycleState struct { ...; ScheduledAt int64 }
// lifecycleSnapshotLocked() 与 updateLifecycle() 都要带上该字段
// taskFromPG(): ScheduledAt: unixOrZero(pt.ScheduledAt)
```

```go
// 编辑任务定义字段：DB 更新 + 内存同步。调用方负责状态约束。
func (m *Manager) UpdateTaskCore(taskID string, patch pgdb.TaskCorePatch) (*Task, error)
// 1. taskStateMu 锁内 m.pg.UpdateTaskCore
// 2. 内存 task：Description/Goal/TimeoutSeconds/PlanHeartbeatSeconds/CoverageEnabled 直接赋值
// 3. updateLifecycle: Name/CategoryID；CategoryName 需按新 id 现查（SELECT 列不含它）
```

```go
// db 层配套
type TaskCorePatch struct {
    Name, Description, Goal *string
    CategoryID *int64
    TimeoutSeconds, PlanHeartbeatSeconds *int
    CoverageEnabled *bool
}
func (d *DB) UpdateTaskCore(id int64, patch TaskCorePatch) (*Task, error)
// UPDATE ... SET 各字段 = COALESCE($n, 旧值) WHERE id=$1 AND deleted_at IS NULL
// RETURNING taskCols → scanTask → hydrateTasksContext([]*Task{task})
```

### 3.4 HTTP 层（server/task_edit.go，一个文件装下两个 handler + 状态约束）

```go
// 编辑（全字段可选，只更新提供的字段）
PUT /api/tasks/{id}/edit
{
  "name"?, "description"?, "goal"?, "category_id"?,
  "timeout_seconds"?, "plan_heartbeat_seconds"?, "coverage_enabled"?,
  "source_task_ids"?: []string,   // 提供即整体替换关联关系
  "scheduled_at"?: string         // 仅未启动任务；""=取消排程，RFC3339=设置/改期
}
```

**状态约束（核心语义，勿丢）**：

```go
func taskCoreEditable(status string) bool {
    return status == "created" || isTerminalStatus(status)
}
// description/goal/source_task_ids：仅 created 与终态可改。
// running/paused 的执行上下文已随 seed/planner 形成，改任务级字段不影响进行中的
// 执行却造成认知不一致 → 409 拒绝（提示走「目标管理」修改目标，planner 会被唤醒）。
// name/category/timeout/heartbeat/coverage：任意状态可改。
// scheduled_at：仅 status=='created'；RFC3339 必须晚于当前时刻；""=取消。
```

```go
// 重新进行：仅终态。三步：重置目标 → admission 复活 → 引擎自动续跑。
POST /api/tasks/{id}/rerun
func (s *Server) rerunTask(w, r) {
    // 1. 校验 isTerminalStatus(lifecycle.Status)，否则 409
    // 2. t.Store.ResetMetGoals()  ← 语义核心：met→open，否则秒退
    // 3. s.admitTask(t, "resume") ← admission 原生支持终态复活：
    //    wasTerminal → status='running'；timeout 任务重置时钟闸 resetTimeoutRevival
    // 4. 返回 {"id", "status": queued|running, "queued"}
}
```

```go
// control 动作扩展：start = 启动一个从未启动过的任务（或提前启动定时任务）
POST /api/tasks/{id}/control  {"action": "start"}
// 仅 status=='created' 可 start；若有排程先 SetTaskScheduled(nil) 清掉；
// 然后与创建时一致：go s.launchTask(t, desc+" "+goal, false)
```

```go
// createTask 请求扩展
type createTaskReq struct {
    ...
    RunMode     string `json:"run_mode,omitempty"`     // immediate(默认)|never|scheduled
    ScheduledAt string `json:"scheduled_at,omitempty"` // RFC3339，scheduled 时必填且必须晚于当前时刻
}
// createTask handler 分支：
// ""/"immediate" → launchTask（原路径）
// "never"        → 仅创建，任务停 created
// "scheduled"    → 校验未来时间 → pg.SetTaskScheduled(id, &at) → 不启动
//                  内存: t.updateLifecycle(func(s){ s.ScheduledAt = at.Unix() })
```

```go
// 调度循环：轮询 DB 而非内存 timer——重启后天然续接排程，无需恢复逻辑
func (s *Server) taskScheduleLoop(ctx context.Context) {
    ticker := time.NewTicker(30 * time.Second)
    for { select { case <-ctx.Done(): return; case <-ticker.C: }
        // LLM/依赖未就绪时不认领（保留 scheduled_at），任务留在排程里等恢复
        if !s.engineReadyForScheduling() { continue }
        ids, _ := s.m.pg.ClaimDueScheduledTasks(time.Now())
        for _, id := range ids {
            t, ok := s.m.Task(strconv.FormatInt(id, 10)); if !ok { continue }
            t.updateLifecycle(func(st *taskLifecycleState){ st.ScheduledAt = 0 }) // 内存同步
            go s.launchTask(t, t.Description+" "+t.Goal, false)
        }
    }
}
// 挂载：New() 里 go s.taskScheduleLoop(s.ctx)
// engineReadyForScheduling(): 至少存在一个 profile 且存在激活 profile（防排程被认领后静默卡死）
```

### 3.5 DTO（server/dto.go）

```go
type TaskDTO struct {
    ... // 新增三个字段
    ScheduledAt          string `json:"scheduled_at"`         // RFC3339; ""=未排程
    TimeoutSeconds       int    `json:"timeout_seconds"`
    PlanHeartbeatSeconds int    `json:"plan_heartbeat_seconds"`
}
// taskDTO 填充: ScheduledAt: unixRFC(lifecycle.ScheduledAt)
func unixRFC(unix int64) string { if unix == 0 { return "" }; return rfc3339(time.Unix(unix, 0)) }
```

### 3.6 路由注册（server/server.go）

```go
mux.HandleFunc("PUT /api/tasks/{id}/edit", s.editTask)
mux.HandleFunc("POST /api/tasks/{id}/rerun", s.rerunTask)
```

## 4. 前端清单

### 4.1 类型与 API（lib/types.ts + lib/api.ts）

```ts
// Task 类型新增
scheduled_at?: string; timeout_seconds?: number; plan_heartbeat_seconds?: number;

// createTask 入参加 runMode?: "immediate"|"never"|"scheduled"、scheduledAt?: string
//   → run_mode / scheduled_at（datetime-local 值需 new Date(v).toISOString() 转 RFC3339）
// editTask: PUT /tasks/{id}/edit（全字段可选）
// rerunTask: POST /tasks/{id}/rerun
// controlTask action 联合类型加 "start"
```

### 4.2 共享表单组件（components/task-form-sheet.tsx）

创建/编辑**双模式**的右侧抽屉（Sheet），编辑与创建字段完全同构：

```tsx
interface TaskFormSheetProps {
  mode: "create" | "edit";
  open: boolean;                    // 受控
  onOpenChange: (open: boolean) => void;
  editTask?: Task | null;           // edit 模式必填
  onSaved?: () => void;             // 保存/创建成功后刷新
  onCategoriesChanged?: () => void;
}
```

要点：
- **数据自加载**（open 时拉 profiles/companies/tasks/categories），列表页与详情页都能直接挂，不依赖 props 传列表
- **edit 预填**：useEffect([open, mode, editTask?.id])，从 task 初始化全部 state；create 打开时清空
- **状态锁**：running/paused 时 description/goal/关联任务 disabled（提示改目标走目标管理）
- **编辑模式隐藏**：模板区/测绘搜资产/文件上传/首个意图 checkbox/拦截规则编辑器（提示去详情页拦截规则 tab）
- **执行方式**：create 三选；edit 仅 created 任务显示（可改期/取消排程）
- **提交**：edit → PUT /edit + LLM 链 diff 后单独调既有链更新 API；create → POST /tasks
- **TaskEditButton**：行内铅笔按钮，只触发 onEdit(task) 回调（表单由调用方以 edit 模式挂载）

### 4.3 列表页与详情页接线

- 列表页：`createOpen` + `editTask` 两个受控 state；新建按钮开 create 模式；行内铅笔 setEditTask 开 edit 模式
- `taskControlAction(status)`：created→"start"；done/failed/timeout→"rerun"；paused→"resume"
- TaskControlButton：终态显示 ▶=rerun（调 rerunTask），列宽不变
- 任务行状态列：`created && scheduled_at` 时显示「MM-dd HH:mm 自动启动」小字
- 详情页 header：✏️ 编辑按钮 + 终态「重新进行」按钮；TaskFormSheet(edit) 挂 Tabs 末尾

## 5. 移植时的关键设计决策（为什么会这样实现）

1. **调度用「轮询 DB」而非内存 timer**：30s tick + 原子认领。重启后无需恢复逻辑，天然续接所有排程；并发 tick 也不会重复启动同一任务（认领即清列）。
2. **认领原子性**：`UPDATE...RETURNING` 把「查到期 + 清排程」合成一步，抢占失败方拿不到 id。
3. **rerun 必须重置 met 目标**：goalless 分支（无 open 目标 + 无活跃意图）会把复活的任务立即再落 done——用户看到的就是"点了没反应"。重置后 planner 才会真正重新规划。
4. **依赖未就绪不认领排程**：认领后引擎空转会让任务"既没排程也没运行"；留在排程里等依赖恢复更合理。
5. **编辑状态边界**：description/goal/关联任务仅 created+终态可改。运行中任务的执行上下文已随 seed/首轮规划固化，改任务级字段不影响进行中的执行，只会造成认知不一致；运行中改目标应走「目标管理」（显式唤醒 planner）。
6. **关联企业不可编辑**：企业关联在创建时牵动资产归属同步（task_scope + assets.task_ids 数组 + task_asset_links），整体替换风险大。
7. **schedule_at 语义**：仅对未启动任务有意义；启动（无论到点还是手动）即清空。

## 6. 已踩过的坑（移植时对照）

1. **Go map 字面量急切求值**：`map[bool]int64{true: at.Unix(), false: 0}[at != nil]` 两个 value 都会求值——at==nil 时直接 nil panic。必须用显式 if/else。这是上线后才暴露的 bug。
2. **lifecycle 快照模式**：Task 可变字段加字段时，`lifecycleSnapshotLocked()` 与 `updateLifecycle()` 两处都要同步，漏一处就是脏读。
3. **SELECT 列清单不含关联名**（如 category_name）：扫描后需 hydrate 或现查，不能直接从 scan 结果取（会拿到空值覆盖内存）。
4. **`is_default` 唯一部分索引**：测试 fixture 插激活 profile 会撞 `uq_llm_one_default`——测试用非默认 profile，且**绝不碰用户真实默认配置**。
5. **测试污染真实库**：测试用真实 PG DSN 会残留 fixture（本库曾残留 20 条垃圾 profile + 磁盘被 go-build 缓存撑满）。移植后建立专用测试库再跑测试。
6. **datetime-local → RFC3339**：前端 `new Date(v).toISOString()`（浏览器按本地时区解析）；后端 `time.Parse(time.RFC3339, ...)` 校验并要求晚于当前时刻。

## 7. 移植步骤 checklist

1. [ ] 目标程序任务表加 `scheduled_at` 列 + 幂等迁移
2. [ ] db 层：struct 字段、SELECT/Scan 列、SetTaskScheduled、ClaimDueScheduledTasks
3. [ ] 图/目标层：ResetMetGoals（若目标系统同构）
4. [ ] manager：内存模型字段 + 快照同步 + UpdateTaskCore
5. [ ] HTTP：PUT edit / POST rerun / control start / create 的 run_mode 分支 + 路由
6. [ ] 调度循环：30s tick + 依赖就绪 gate + 挂载启动
7. [ ] DTO：scheduled_at / timeout / heartbeat 暴露给前端
8. [ ] 前端：类型 + API 方法 + TaskFormSheet 双模式 + 行内按钮/状态展示
9. [ ] 测试：编辑全字段回读、取消排程（曾 panic 路径）、rerun 前后目标状态、并发认领幂等
10. [ ] 把 `launchTask` 换成目标程序的「任务启动」钩子；`admitTask` 换成其准入/并发控制
11. [ ] 文案与状态映射按目标程序的 status 枚举适配

## 8. 依赖映射（ARTEX2 特有 → 移植点）

| ARTEX2 内部 | 作用 | 移植替换点 |
|---|---|---|
| `launchTask(t, seedText, seedFirstIntent)` | 创建后流程：seed → 可选种子意图 → admission | 目标程序的「任务启动钩子」 |
| `admitTask(t, mode)` / `startAdmittedTask` | 并发准入 + FIFO 队列 + 引擎启动 | 目标程序的并发控制/队列 |
| `t.Store.ResetMetGoals()` | 目标图状态重置 | 目标程序的目标/意图状态机 |
| `lifecycleSnapshot/updateLifecycle` | 任务可变字段的一致性视图 | 等价的内存状态同步机制 |
| `settings` 表 | 并发上限/LLM 就绪等运行时配置 | 任意 KV 配置源 |
| `engine.ReadyFor` / `engineReadyForScheduling` | 依赖（LLM 等）就绪判定 | 目标程序的资源就绪判定 |
