"use client";

import * as React from "react";

import { useRouter } from "next/navigation";
import { SendIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/api";

interface FindingSubmitSkillDialogProps {
  findingId: string;
  findingName?: string;
  onClose: () => void;
}

// 触发 butian-submit skill：创建独立对话会话并发一条指令，让 agent 按 skill
// 流程起草+填表；最终「提交漏洞」仍由用户在浏览器里人工确认（合规闸门）。
export function FindingSubmitSkillDialog({ findingId, findingName, onClose }: FindingSubmitSkillDialogProps) {
  const router = useRouter();
  const cidId = React.useId();
  const [cid, setCid] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const submitLock = React.useRef(false);

  async function start() {
    if (submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    try {
      const c = await api.createConversation("auto", `提交漏洞 #${findingId}`);
      const cidPart = cid.trim() ? `\n- 目标厂商补天 cid：${cid.trim()}` : "";
      const message = [
        `请使用 butian-submit skill，把 ARTEX2 的漏洞 #${findingId} 提交到补天平台。`,
        `- 漏洞编号（findings.id / finding_id）：${findingId}`,
        findingName ? `- 漏洞名称：${findingName}` : "",
        cidPart,
        "",
        "按 skill 流程执行：先 fetch_finding.sh 拉材料，核对厂商收录范围与域名归属，起草报告并填表。",
        "注意：最终「提交漏洞」按钮必须留给我人工点击确认，脚本只起草+填表，不要自行点最终提交。",
      ]
        .filter((x) => x !== "")
        .join("\n");
      await api.sendConversationMessage(c.id, message);
      toast.success("已创建提交会话，agent 正在按 butian-submit skill 起头");
      onClose();
      router.push(`/chat?c=${c.id}`);
    } catch (e) {
      toast.error(`发起提交失败：${(e as Error).message}`);
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !submitLock.current && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>提交到补天 · #{findingId}</DialogTitle>
          <DialogDescription className="break-words">
            {findingName ? <span className="mb-2 block">{findingName}</span> : null}
            将创建独立对话会话，agent 使用 <code>butian-submit</code> skill 拉取该漏洞材料、核对归属、起草报告并填表。
            最终「提交漏洞」按钮仍需你在浏览器里人工复核后点击（合规闸门，脚本不代劳）。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field data-disabled={submitting}>
            <FieldLabel htmlFor={cidId}>目标厂商 cid（可选）</FieldLabel>
            <Input
              id={cidId}
              value={cid}
              maxLength={20}
              disabled={submitting}
              onChange={(e) => setCid(e.target.value)}
              placeholder="例如：65358（长沙市希尚网络科技有限公司）"
            />
            <FieldDescription>留空则由 agent 从补天公益 SRC 列表按厂商名查找；已知 cid 可加速。请确保漏洞域名属于该厂商。</FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button disabled={submitting} onClick={() => void start()}>
            {submitting ? <Spinner data-icon="inline-start" /> : <SendIcon data-icon="inline-start" />}
            {submitting ? "创建中…" : "创建提交会话"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
