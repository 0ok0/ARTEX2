package server

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Autumn-27/artex/db"
)

// 任务编辑的状态边界：description/goal 是任务的执行定义——created(尚未启动)与终态
// (done/failed/timeout，配合「重新进行」)任务可改；running/paused 的执行上下文已随
// seed/planner 形成，改任务级字段不影响进行中的执行且会造成认知不一致，故拒绝
// （运行中调整目标走 goals 管理 PATCH /tasks/{id}/goals/{gid}，planner 会被显式唤醒）。
func taskCoreEditable(lifecycleStatus string) bool {
	return lifecycleStatus == "created" || isTerminalStatus(lifecycleStatus)
}

// editTask 允许用户在创建后修改任务的定义字段并按新内容重新执行。
// 可编辑：name/description/goal/category_id/timeout_seconds/plan_heartbeat_seconds/
// coverage_enabled（全部可选，只更新提供的字段）。
func (s *Server) editTask(w http.ResponseWriter, r *http.Request) {
	t, ok := s.m.Task(r.PathValue("id"))
	if !ok {
		writeErr(w, http.StatusNotFound, "task not found")
		return
	}
	if s.engine.IsDeleting(t.ID) {
		writeErr(w, http.StatusConflict, "任务正在删除，无法编辑")
		return
	}
	var req struct {
		Name                 *string  `json:"name,omitempty"`
		Description          *string  `json:"description,omitempty"`
		Goal                 *string  `json:"goal,omitempty"`
		CategoryID           *int64   `json:"category_id,omitempty"`
		TimeoutSeconds       *int     `json:"timeout_seconds,omitempty"`
		PlanHeartbeatSeconds *int     `json:"plan_heartbeat_seconds,omitempty"`
		CoverageEnabled      *bool    `json:"coverage_enabled,omitempty"`
		SourceTaskIDs        []string `json:"source_task_ids,omitempty"` // 提供即整体替换关联任务
		ScheduledAt          *string  `json:"scheduled_at,omitempty"`    // 仅 created 任务可改；""=取消排程，RFC3339=设置/改期
	}
	if err := decode(r, &req); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	patch := db.TaskCorePatch{}
	coreChanged := false
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			writeErr(w, 400, "任务名称不能为空")
			return
		}
		if utf8.RuneCountInString(name) > maxTaskNameRunes {
			writeErr(w, 400, fmt.Sprintf("任务名称最多 %d 个字符", maxTaskNameRunes))
			return
		}
		patch.Name = &name
		coreChanged = true
	}
	if req.Description != nil || req.Goal != nil {
		lifecycle := t.lifecycleSnapshot()
		if !taskCoreEditable(lifecycle.Status) {
			writeErr(w, 409, "运行中/已暂停的任务不能修改描述与目标；运行中调整目标请在任务详情的「目标管理」里编辑（planner 会被唤醒重新规划），或先暂停")
			return
		}
		if req.Description != nil {
			desc := strings.TrimSpace(*req.Description)
			if desc == "" {
				writeErr(w, 400, "任务描述不能为空")
				return
			}
			patch.Description = &desc
		}
		if req.Goal != nil {
			goal := strings.TrimSpace(*req.Goal)
			if goal == "" {
				writeErr(w, 400, "任务目标不能为空")
				return
			}
			patch.Goal = &goal
		}
		coreChanged = true
	}
	if req.CategoryID != nil {
		if *req.CategoryID <= 0 {
			patch.CategoryID = req.CategoryID // 负数/0 不可能：前端传 null 表示移除分类，这里拒绝
			writeErr(w, 400, "任务分类 id 无效")
			return
		}
		if _, err := s.m.pg.GetTaskCategory(*req.CategoryID); err != nil {
			if errors.Is(err, db.ErrTaskCategoryNotFound) {
				writeErr(w, 400, "任务分类不存在")
				return
			}
			writeErr(w, 500, err.Error())
			return
		}
		patch.CategoryID = req.CategoryID
		coreChanged = true
	}
	if req.TimeoutSeconds != nil {
		ts := *req.TimeoutSeconds
		if ts < 0 {
			ts = 0
		}
		patch.TimeoutSeconds = &ts
		coreChanged = true
	}
	if req.PlanHeartbeatSeconds != nil {
		hs := *req.PlanHeartbeatSeconds
		// 与创建归一一致：下限 300(5min)，低于自动抬到 300。
		if hs < 300 {
			hs = 300
		}
		patch.PlanHeartbeatSeconds = &hs
		coreChanged = true
	}
	if req.CoverageEnabled != nil {
		patch.CoverageEnabled = req.CoverageEnabled
		coreChanged = true
	}
	// 关联来源任务：整体替换只读继承关系。仅 created/终态可改（同 description/goal 的边界）。
	if req.SourceTaskIDs != nil {
		lifecycle := t.lifecycleSnapshot()
		if !taskCoreEditable(lifecycle.Status) {
			writeErr(w, 409, "运行中/已暂停的任务不能修改关联任务")
			return
		}
		if len(req.SourceTaskIDs) > db.MaxTaskSourceCount {
			writeErr(w, 400, fmt.Sprintf("关联任务最多选择 %d 个", db.MaxTaskSourceCount))
			return
		}
		sourceIDs := make([]int64, 0, len(req.SourceTaskIDs))
		seen := map[int64]bool{}
		selfID := t.int64ID()
		for _, raw := range req.SourceTaskIDs {
			id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
			if err != nil || id <= 0 || id == selfID || seen[id] {
				writeErr(w, 400, "关联任务 id 无效或重复")
				return
			}
			if _, ok := s.m.Task(strconv.FormatInt(id, 10)); !ok {
				writeErr(w, 400, fmt.Sprintf("关联任务 #%d 不存在", id))
				return
			}
			seen[id] = true
			sourceIDs = append(sourceIDs, id)
		}
		if err := s.m.pg.ReplaceTaskRelations(selfID, sourceIDs); err != nil {
			writeErr(w, 500, "更新关联任务失败："+err.Error())
			return
		}
		coreChanged = true
	}
	// 执行计划：仅 created(未启动)任务可调整定时排程——设置/改期/取消。
	if req.ScheduledAt != nil {
		if t.lifecycleSnapshot().Status != "created" {
			writeErr(w, 409, "仅未启动的任务可以修改执行计划")
			return
		}
		raw := strings.TrimSpace(*req.ScheduledAt)
		var at *time.Time
		if raw != "" {
			parsed, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				writeErr(w, 400, "scheduled_at 无效：需要 RFC3339 格式")
				return
			}
			if !parsed.After(time.Now()) {
				writeErr(w, 400, "scheduled_at 必须晚于当前时刻")
				return
			}
			at = &parsed
		}
		if err := s.m.pg.SetTaskScheduled(t.int64ID(), at); err != nil {
			writeErr(w, 500, "更新执行计划失败："+err.Error())
			return
		}
		// 注意不能用 map[bool]int64{true: at.Unix(), ...}[at != nil] 这类写法——
		// Go 的 map 字面量两个 value 都会急切求值，at==nil 时 at.Unix() 直接 panic。
		t.updateLifecycle(func(state *taskLifecycleState) {
			if at != nil {
				state.ScheduledAt = at.Unix()
			} else {
				state.ScheduledAt = 0
			}
		})
		coreChanged = true
	}
	if !coreChanged {
		writeErr(w, 400, "至少需要提供一个待编辑字段")
		return
	}

	updated, err := s.m.UpdateTaskCore(t.ID, patch)
	if err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	if updated == nil {
		writeErr(w, http.StatusNotFound, "task not found")
		return
	}
	log.Printf("[task] #%s 已编辑定义字段", t.ID)
	writeJSON(w, 200, taskDTO(updated, s.resolvedTaskStatus(updated)))
}

// rerunTask 重新进行一个已结束的任务：终态(done/failed/timeout)任务按 admission
// 的终态复活路径恢复运行(status→running，timeout 任务重置时钟闸)，已有图/资产/目标
// 保留，planner 据现状继续。未启动(created)任务请用 control start；运行中任务无需 rerun。
func (s *Server) rerunTask(w http.ResponseWriter, r *http.Request) {
	t, ok := s.m.Task(r.PathValue("id"))
	if !ok {
		writeErr(w, http.StatusNotFound, "task not found")
		return
	}
	lifecycle := t.lifecycleSnapshot()
	if !isTerminalStatus(lifecycle.Status) {
		writeErr(w, 409, "仅已结束(done/failed/timeout)的任务可以重新进行；未启动任务请启动，运行中任务无需重跑")
		return
	}
	if s.engine.IsDeleting(t.ID) {
		writeErr(w, http.StatusConflict, "任务正在删除")
		return
	}
	// 重跑语义：终态任务复活前把已 met 的目标重置为 open——否则 planner 会立刻
	// 再次判定「目标已全部达成」落 done，用户看到的重新进行等于什么都没做。
	// （goalless 直投任务的结束正是由「无 open 目标 + 无活跃意图」驱动。）
	reset, err := t.Store.ResetMetGoals()
	if err != nil {
		writeErr(w, 500, "重置目标状态失败："+err.Error())
		return
	}
	if reset > 0 {
		log.Printf("[task] #%s 重新进行：已重置 %d 个 met 目标为 open", t.ID, reset)
	}
	queued, err := s.admitTask(t, "resume")
	if err != nil {
		writeErr(w, 409, err.Error())
		return
	}
	log.Printf("[task] #%s 重新进行(此前状态: %s)", t.ID, lifecycle.Status)
	writeJSON(w, 200, map[string]any{"id": t.ID, "status": map[bool]string{true: "queued", false: "running"}[queued], "queued": queued})
}
