"use client";

// 任务页「当前任务 / 已归档」切换的全局状态——切换控件已上移到全局菜单栏
// （MainContent 的 header），任务页本体只消费这个 store。
import { useSyncExternalStore } from "react";

let value = "current";
const listeners = new Set<() => void>();

export const tasksTabStore = {
  get: () => value,
  set: (v: string) => {
    value = v;
    listeners.forEach((l) => l());
  },
  subscribe: (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useTasksTab() {
  return useSyncExternalStore(tasksTabStore.subscribe, tasksTabStore.get);
}
