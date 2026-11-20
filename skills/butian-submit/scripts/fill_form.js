// fill_form.js — 补天提交表单填写模板（browse execute --file 使用）
//
// 用法：把下面的 CONFIG 改成本次提交的实际内容，然后:
//   browse execute --file fill_form.js
//
// ⛔ 本脚本【不点提交按钮】。填完回读校验后交给用户复核；
//    只有用户明确说「确认提交」后，才执行文件末尾注释里的提交代码。
//
// 依赖：提交页标签复用（找不到会自动重开）。公告弹窗由脚本程序化点「稍后再说」关闭（合规须知确认，非提交动作）——
//       实测 button.ln-btn-ghost 可点；点完回读确认弹窗已关再填表。若连 .ln-close 都点不掉才 handoff 用户手动。
// ⛔ 最终「提交漏洞」按钮永远不点——只有用户明确说「确认提交」后才人工完成。

const CONFIG = {
  host: "u.example.cn",                                    // 域名或ip
  url: "https://u.example.cn/micro/login",                 // 漏洞URL
  title: "某单位网站存在XX漏洞",                            // 单位名称+漏洞类型
  cate: "Web漏洞",                                          // selCate: Web漏洞 / IoT漏洞
  type: "弱口令",                                           // type 下拉选项见 SKILL.md
  attribute: "事件型",                                      // attribute: 事件型 / 通用型
  level: "高危",                                            // level: 高危 / 中危 / 低危
  description: "一句话简要描述。",
  prove: "POST /path HTTP/1.1\nHost: xxx\n\nbody...",
  detailHtml: "<p><strong>1、漏洞所在功能点：</strong>...</p><p><strong>2、复现过程：</strong>...</p>",
  repair: "修复建议...",
  province: "湖南省",                                       // 可为 null 跳过
  city: "长沙市",
  industry: "信息传输",                                     // industryLoo1 选项的子串匹配
};

// ── 标签页：找不到就重开（坑位⑨：browse 会回收 agent 标签，随时可能消失）──
let pg = context.pages().find(p => (p.url() || "").includes("Loo/submit"));
if (!pg) {
  pg = await context.newPage();
  await pg.setViewportSize({ width: 1440, height: 900 });
  await pg.goto("https://www.butian.net/Loo/submit?cid=<厂商cid>", { timeout: 30000, waitUntil: "domcontentloaded" }).catch(() => {});
  await pg.waitForTimeout(3500);
}

// ── 0) 关公告弹窗：程序化点「稍后再说」+ 回读确认（坑位①：实测可点）──
// 重开后弹窗必再现。首选 button.ln-btn-ghost「稍后再说」；不行再试 .ln-close；仍不行才 handoff。
await pg.evaluate(() => {
  const b = Array.from(document.querySelectorAll("button.ln-btn-ghost")).find(x => (x.innerText||"").includes("稍后再说"));
  if (b && !b.disabled) b.click();
});
await pg.waitForTimeout(1300);
const pre = await pg.evaluate(() => {
  const mask = document.querySelector(".ln-mask");
  const visible = mask && mask.offsetWidth > 0 && getComputedStyle(mask).display !== "none";
  return { modalVisible: !!visible || document.body.innerText.includes("我已阅读并知晓") };
});
if (pre.modalVisible) {
  // 备用：× 按钮
  await pg.evaluate(() => { const x = document.querySelector("button.ln-close"); if (x && !x.disabled) x.click(); });
  await pg.waitForTimeout(1000);
  const pre2 = await pg.evaluate(() => {
    const mask = document.querySelector(".ln-mask");
    return !!mask && mask.offsetWidth > 0 && getComputedStyle(mask).display !== "none";
  });
  if (pre2) return { modalVisible: true, err: "公告弹窗无法程序化关闭：请手动关掉后重跑本脚本" };
}

// ── 1) 下拉框 ──
await pg.locator("select[name='selCate']").first().selectOption({ label: CONFIG.cate });
await pg.waitForTimeout(600);
await pg.locator("select[name='type']").first().selectOption({ label: CONFIG.type });
await pg.waitForTimeout(400);
await pg.locator("select[name='level']").first().selectOption({ label: CONFIG.level });
await pg.waitForTimeout(400);

// ── 2) 文本输入（host/title/url[] 用 Playwright fill；多实例字段用 JS 全量设值）──
await pg.locator("input[name='host']").first().fill(CONFIG.host);
await pg.locator("input[name='url[]']").first().fill(CONFIG.url);
await pg.locator("input[name='title']").first().fill(CONFIG.title);
await pg.evaluate((c) => {
  const set = (n, v) => {
    document.querySelectorAll(`[name='${n}']`).forEach(e => {
      e.value = v;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };
  set("description", c.description);
  set("prove", c.prove);
  set("repair_suggest", c.repair);
}, CONFIG);

// ── 3) detail：UEditor 桥接（见 SKILL.md 坑位③）──
await pg.evaluate((html) => {
  const sc = document.createElement("script");
  sc.textContent = "(function(){try{var keys=Object.keys(UE.instants||{});var target=null;" +
    "for(var i=0;i<keys.length;i++){var ed=UE.instants[keys[i]];if(ed.textarea&&ed.textarea.name==='detail'){target=ed;break;}}" +
    "if(target){target.ready(function(){target.setContent(" + JSON.stringify(html) + ");if(target.sync)target.sync();document.documentElement.setAttribute('data-ue-len',(target.getContent()||'').length);});" +
    "document.documentElement.setAttribute('data-ue-found','y');}else{document.documentElement.setAttribute('data-ue-found','n');}}catch(e){document.documentElement.setAttribute('data-ue-err',String(e).slice(0,150));}})();";
  document.documentElement.appendChild(sc);
  sc.remove();
}, CONFIG.detailHtml);
await pg.waitForTimeout(2500);

// ── 4) 行业 / 地区（子串匹配选项）──
await pg.evaluate((c) => {
  function pick(selName, match) {
    if (!match) return;
    const s = document.querySelector(`select[name='${selName}']`);
    if (!s) return;
    const opt = Array.from(s.options).find(o => o.innerText.trim().includes(match));
    if (opt) { s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); }
  }
  pick("industryLoo1", c.industry);
  pick("province", c.province);
}, CONFIG);
await pg.waitForTimeout(1200);
await pg.evaluate((c) => {
  function pick(selName, match) {
    if (!match) return;
    const s = document.querySelector(`select[name='${selName}']`);
    if (!s) return;
    const opt = Array.from(s.options).find(o => o.innerText.trim().includes(match));
    if (opt) { s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); }
  }
  pick("city", c.city);
}, CONFIG);
await pg.waitForTimeout(800);

// ── 5) 附件：已移除——上传链路不稳定，证据文字化进详细细节，用户需要时手动补传 ──


// ── 6) 回读校验 ──
await pg.waitForTimeout(500);
const check = await pg.evaluate(() => {
  const g = n => { const e = document.querySelector(`[name='${n}']`); return e ? (e.value || "").slice(0, 46) : null; };
  const L = n => { const e = document.querySelector(`[name='${n}']`); return e ? (e.value || "").length : 0; };
  const selTxt = n => { const s = document.querySelector(`select[name='${n}']`); return s && s.selectedOptions && s.selectedOptions[0] ? s.selectedOptions[0].innerText.trim() : null; };
  return {
    company: g("company_name"), host: g("host"), url0: g("url[]"), title: g("title"),
    cate: selTxt("selCate"), type: selTxt("type"), level: selTxt("level"), attr: selTxt("attribute"),
    industry: selTxt("industryLoo1"), province: selTxt("province"), city: selTxt("city"),
    descLen: L("description"), proveLen: L("prove"), detailLen: L("detail"), repairLen: L("repair_suggest"),
    detailHasMarker: (document.querySelector("textarea[name='detail']") || { value: "" }).value.includes("漏洞所在功能点"),
  };
});
await pg.evaluate(() => window.scrollTo(0, 0));
await pg.bringToFront().catch(() => {});
return { ok: true, check };

// ══════════════════════════════════════════════════════════════════
// ⛔ 提交（仅在用户明确说「确认提交」后，手动去掉注释单独执行）：
//
// const pg = context.pages().find(p => (p.url() || "").includes("Loo/submit"));
// await pg.locator("button", { hasText: /^提交$/ }).first().click();
// await pg.waitForTimeout(5000);
// return await pg.evaluate(() => document.body.innerText.slice(0, 400));
// ══════════════════════════════════════════════════════════════════
