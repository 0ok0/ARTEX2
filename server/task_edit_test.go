package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
)

// TestTaskEditAndRerunHTTP 覆盖任务编辑与重新进行的完整 HTTP 链路：
//  1. created(run_mode=never) 任务可编辑 description/goal/name/timeout（200，DTO 回读）
//  2. created 任务 rerun → 409（未启动任务用 start，不是 rerun）
//  3. running 任务编辑 description/goal → 409（执行上下文已形成）
//  4. 终态(done)任务编辑 description → 200（配合重新进行）
//  5. done 任务 rerun → 200（终态复活路径；测试环境无 LLM 配置 → queued）
func TestTaskEditAndRerunHTTP(t *testing.T) {
	m, err := NewManager(t.TempDir(), "")
	if err != nil {
		t.Skipf("postgres unavailable (%v) — skipping", err)
	}
	defer m.Close()
	s := New(context.Background(), m, t.TempDir(), t.TempDir(), t.TempDir())
	h := s.Handler()
	token, err := signJWT(s.jwtKey)
	if err != nil {
		t.Fatal(err)
	}

	do := func(method, path string, body any) (int, map[string]any) {
		var data []byte
		if body != nil {
			data, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(data))
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		var out map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &out)
		return rec.Code, out
	}

	// 创建一个 never 任务：停在 created，不触发 LLM。
	code, body := do("POST", "/api/tasks", map[string]any{
		"description": "编辑测试任务", "goal": "原始目标", "run_mode": "never",
	})
	if code != 201 {
		t.Fatalf("create: %d %v", code, body)
	}
	id := fmt.Sprint(body["id"])
	t.Cleanup(func() {
		if n, _ := id2int64(id); n > 0 {
			_, _ = m.pg.Exec(`DELETE FROM tasks WHERE id=$1`, n)
		}
	})

	// 1) created 可编辑核心字段
	code, body = do("PUT", "/api/tasks/"+id+"/edit", map[string]any{
		"name": "编辑后的名字", "description": "编辑后的描述", "goal": "编辑后的目标", "timeout_seconds": 60,
	})
	if code != 200 {
		t.Fatalf("edit created: %d %v", code, body)
	}
	if body["description"] != "编辑后的描述" || body["goal"] != "编辑后的目标" {
		t.Fatalf("edit created round-trip 失败: %v", body)
	}
	if body["timeout_seconds"].(float64) != 60 {
		t.Fatalf("timeout 未生效: %v", body["timeout_seconds"])
	}

	// 1a) 排程回归：取消排程（scheduled_at=""）曾因 map 字面量急切求值 at.Unix() 而 panic。
	//     覆盖：设置排程 → 取消 → 再设置，三次都必须 200 且 scheduled_at 正确回读。
	code, body = do("PUT", "/api/tasks/"+id+"/edit", map[string]any{"scheduled_at": "2026-12-01T09:00:00+08:00"})
	if code != 200 {
		t.Fatalf("设置排程: %d %v", code, body)
	}
	if body["scheduled_at"] == "" {
		t.Fatalf("设置排程后 scheduled_at 未回读: %v", body)
	}
	code, body = do("PUT", "/api/tasks/"+id+"/edit", map[string]any{"scheduled_at": ""})
	if code != 200 {
		t.Fatalf("取消排程（曾 panic 的路径）: %d %v", code, body)
	}
	if body["scheduled_at"] != "" {
		t.Fatalf("取消排程后 scheduled_at 应为空: %v", body["scheduled_at"])
	}
	code, _ = do("PUT", "/api/tasks/"+id+"/edit", map[string]any{"scheduled_at": "2026-12-01T09:00:00+08:00"})
	if code != 200 {
		t.Fatalf("重新设置排程: %d", code)
	}
	// 清掉排程，避免影响后续用例的 rerun 断言
	_, _ = do("PUT", "/api/tasks/"+id+"/edit", map[string]any{"scheduled_at": ""})

	// 1b) created 可整体替换关联任务 + 设置排程（source 指向自身应被拒绝）
	code, _ = do("PUT", "/api/tasks/"+id+"/edit", map[string]any{"source_task_ids": []string{id}})
	if code != 400 {
		t.Fatalf("source=self 应 400, got %d", code)
	}
	code, _ = do("PUT", "/api/tasks/"+id+"/edit", map[string]any{"scheduled_at": "2000-01-01T00:00:00Z"})
	if code != 400 {
		t.Fatalf("过去时间排程应 400, got %d", code)
	}

	// 2) created 任务 rerun → 409
	code, _ = do("POST", "/api/tasks/"+id+"/rerun", nil)
	if code != 409 {
		t.Fatalf("rerun created 应 409, got %d", code)
	}

	// 3) 模拟 running：改 DB + 内存状态后，编辑 description/goal → 409
	markTaskStatus(t, m, s, id, "running")
	code, _ = do("PUT", "/api/tasks/"+id+"/edit", map[string]any{"description": "运行中不该改"})
	if code != 409 {
		t.Fatalf("edit running description 应 409, got %d", code)
	}
	// 但 name 仍可编辑
	code, _ = do("PUT", "/api/tasks/"+id+"/edit", map[string]any{"name": "运行中也能改名"})
	if code != 200 {
		t.Fatalf("edit running name 应 200, got %d", code)
	}

	// 4) 终态 done：编辑 description → 200
	markTaskStatus(t, m, s, id, "done")
	code, body = do("PUT", "/api/tasks/"+id+"/edit", map[string]any{"description": "终态改描述"})
	if code != 200 {
		t.Fatalf("edit done: %d %v", code, body)
	}

	// 5) 建一个激活的有效 profile 后 rerun → 200（终态复活路径）。engine idle（LLM 未配置）
	//    时 loops 也会起来等 LLM（Run 的设计行为），因此 rerun 无论 LLM 是否就绪都应成功。
	seedProfile(t, m, "rerun-test-profile")
	code, body = do("POST", "/api/tasks/"+id+"/rerun", nil)
	if code != 200 {
		t.Fatalf("rerun done: %d %v", code, body)
	}
	st, _ := body["status"].(string)
	if st != "queued" && st != "running" {
		t.Fatalf("rerun 后状态异常: %v", body)
	}
}

// seedProfile inserts a plain profile so the rerun scenario has a realistic fixture.
// Not is_default (a unique partial index allows only one default; the user's real
// default must never be touched by tests). Removed on cleanup.
func seedProfile(t *testing.T, m *Manager, name string) int64 {
	t.Helper()
	var pid int64
	if err := m.pg.QueryRow(`INSERT INTO llm_profiles(name, format, base_url, model, api_key)
VALUES ($1, 'openai', 'http://127.0.0.1:9', 'test-model', 'test-key')
ON CONFLICT (name) DO UPDATE SET base_url=EXCLUDED.base_url RETURNING id`, name).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = m.pg.Exec(`DELETE FROM llm_profiles WHERE name=$1 AND is_default=false`, name)
	})
	return pid
}

func id2int64(id string) (int64, error) {
	var n int64
	_, err := fmt.Sscan(id, &n)
	return n, err
}

// markTaskStatus puts the task into an arbitrary lifecycle status both in PG and
// in the in-memory Task the handlers read.
func markTaskStatus(t *testing.T, m *Manager, s *Server, id string, status string) {
	t.Helper()
	n, err := id2int64(id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.pg.Exec(`UPDATE tasks SET status=$2, queued=false, paused=false WHERE id=$1`, n, status); err != nil {
		t.Fatal(err)
	}
	task, ok := m.Task(id)
	if !ok {
		t.Fatal("task not in memory")
	}
	task.updateLifecycle(func(state *taskLifecycleState) { state.Status = status })
	_ = s
}
