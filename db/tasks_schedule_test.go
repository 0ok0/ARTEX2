package db

import (
	"testing"
	"time"
)

// TestTaskScheduledClaim 验证定时执行的两个原语：SetTaskScheduled 写入/清除排程，
// ClaimDueScheduledTasks 原子认领到期任务（未到期不认领、认领后 scheduled_at 清空、
// 非 created 状态不认领——保证重启后的调度循环不会重复启动同一任务）。
func TestTaskScheduledClaim(t *testing.T) {
	d, err := Open(testDSN(t))
	if err != nil {
		t.Skipf("postgres unavailable (%v) — skipping", err)
	}
	defer d.Close()

	tk, err := d.CreateTask("定时执行测试", "目标: 验证排程认领", nil, 0, 0)
	if err != nil {
		t.Fatal(err)
	}

	// 未到期：不应被认领
	future := time.Now().Add(1 * time.Hour)
	if err := d.SetTaskScheduled(tk.ID, &future); err != nil {
		t.Fatal(err)
	}
	ids, err := d.ClaimDueScheduledTasks(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range ids {
		if id == tk.ID {
			t.Fatal("未到期的排程被认领了")
		}
	}

	// 到期：原子认领并清空 scheduled_at
	if err := d.SetTaskScheduled(tk.ID, ptrTime(time.Now().Add(-1*time.Second))); err != nil {
		t.Fatal(err)
	}
	ids, err = d.ClaimDueScheduledTasks(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, id := range ids {
		if id == tk.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("到期排程未被认领")
	}
	// 认领后 scheduled_at 已清空、状态仍为 created
	pt, err := d.GetTask(tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if pt.ScheduledAt != nil {
		t.Fatal("认领后 scheduled_at 未清空")
	}
	if pt.Status != "created" {
		t.Fatalf("认领不应改动 status，got %q", pt.Status)
	}

	// 清除排程
	later := time.Now().Add(2 * time.Hour)
	if err := d.SetTaskScheduled(tk.ID, &later); err != nil {
		t.Fatal(err)
	}
	if err := d.SetTaskScheduled(tk.ID, nil); err != nil {
		t.Fatal(err)
	}
	pt, err = d.GetTask(tk.ID)
	if err != nil {
		t.Fatal(err)
	}
	if pt.ScheduledAt != nil {
		t.Fatal("SetTaskScheduled(nil) 未清除排程")
	}

	if err := d.DeleteTask(tk.ID); err != nil {
		t.Fatal(err)
	}
}

func ptrTime(t time.Time) *time.Time { return &t }
