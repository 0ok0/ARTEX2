---
name: butian-submit
description: 把 ARTEX2 findings（或用户提供的漏洞）提交到补天平台（butian.net）。涉及「提交漏洞」「补天」「SRC 提交」「漏洞上报」时使用。要求 browse MCP 已配对用户 Chrome，且补天登录态有效。
---

# Butian Submit（补天漏洞提交）

把 ARTEX2 的 finding（或用户给的漏洞材料）提交到补天漏洞响应平台。**浏览器动作全部通过 browse MCP 的 `browse execute --file <script.js>` 完成**——它驱动的是用户真实 Chrome（带登录态）。

## ⛔ 硬性合规闸门（补天平台规则，不可绕过）

1. **最终「提交」按钮必须人工放行**：脚本永远不点提交。流程是 起草 → 填表 → 用户肉眼复核 → 用户明确说「确认提交」→ 才执行一次点击。补天公告明文要求：高风险操作必须人工确认，禁止 AI 自主执行。
2. 报告内容须基于**真实测试证据**（ARTEX2 finding 的 evidence/report，或用户提供的材料），禁止编造复现细节。
3. 仅使用测试号段/自造标识做验证，禁止爆破、禁止触碰真实商家数据。
4. 提交前核对厂商收录范围：漏洞域名必须属于目标厂商（参考 ICP 备案/厂商收录页），跨厂商提交会被拒收。

## 前置条件

| 项 | 检查方式 |
|---|---|
| browse 已配对 | `browse status` → Extension: connected |
| 补天登录态 | 打开 https://www.butian.net/ 看头部是否显示用户名（登录失效会出现「迷失了」页，需用户手动登录） |
| 数据库访问 | `export PGPASSWORD=<artex密码> && psql -h 127.0.0.1 -U artex -d artex` |
| 目标厂商 cid | 从用户获得，或从公益SRC列表 `/Reward/plan/2` 按厂商名查找 |

## 流程总览

```
1. fetch_finding.sh <finding_id>     # 从 ARTEX2 库拉漏洞材料
2. 与用户确认：提交哪个 finding、目标厂商 cid、漏洞域名归属
3. （截图/zip 环节已移除——证据文字化）
4. 打开提交页 → **关公告弹窗**：程序化点「稍后再说」（button.ln-btn-ghost）→ 回读确认已关（坑位①）
5. fill_form.js 填表（关弹窗→字段→UEditor；填前确认弹窗已关）
6. 用户肉眼复核表单 → 明确「确认提交」
7. click_submit（一次点击）→ 回读结果（漏洞编号）→ browse session reset
```

## 表单字段映射（ARTEX2 finding → 补天）

| 补天字段 | 填法 |
|---|---|
| 厂商 company_name | 由 `?cid=` 自动带出，勿改 |
| 域名或ip host | 漏洞所在域名（如 `u.jubaozan.cn`） |
| 漏洞类别 selCate | `Web漏洞`（或 IoT漏洞） |
| 漏洞标题 title | 「单位名称+漏洞类型」格式，例：`长沙市希尚网络科技有限公司聚宝赞平台存在硬编码默认口令未授权登录漏洞` |
| 漏洞URL url[] | 完整漏洞 URL |
| 漏洞类型 type | 下拉：XSS/配置错误/弱口令/入侵事件/疑似被黑/文件上传/信息泄露/存在后门/逻辑漏洞/代码执行/命令执行/SQL注入/解析漏洞 |
| 属性 attribute | `事件型`（针对特定站点）/ `通用型` |
| 漏洞等级 level | **只有** 高危/中危/低危（没有「严重」档；RCE/认证绕过选高危） |
| 简要描述 description | 一句话概括（纯 textarea） |
| 证明/数据包 prove | 完整 HTTP 请求+响应包 |
| 详细细节 detail | **UEditor 富文本**——见下方坑位 ③ |
| 修复建议 repair_suggest | 文本 |
| 所属行业 industryLoo1 | 国民经济行业分类（20 项），选厂商对应行业 |
| 所属地区 province/city | 级联下拉；county 可留空 |
| 附件 file | **只收 `.rar,.zip`**（见坑位 ⑤）；单个文件 |

## ⚠️ DOM 坑位（2026-11-16 实战沉淀，每次改版后先跑「回读校验」确认仍成立）

### ① 公告弹窗（每次进提交页必弹）——首选程序化点「稍后再说」关闭
- 宿主 `div.ln-mask`，勾选框 `input[name='lnAgree']` 初始 **disabled**，「我已阅读」按钮初始也 disabled。
- **✅ 首选：程序化点「稍后再说」（2026-11-17 实测确认可点）**：
  ```js
  const b = Array.from(document.querySelectorAll("button.ln-btn-ghost")).find(x => (x.innerText||"").includes("稍后再说"));
  if (b && !b.disabled) b.click();   // 关闭弹窗，需 await waitForTimeout(~1200)
  ```
  实测：点击后 `div.ln-mask` 消失、页面文本不再含「我已阅读并知晓」、表单字段出现。**这是关公告弹窗、不是提交动作，程序化完全合规**。
- **备用关闭方式**：`button.ln-close`（×）同样可点。
- 「我已阅读」按钮（`button.ln-btn-primary`）初始 disabled——需把 `.ln-body` 滚到底（`scrollTop = scrollHeight` + 派发 scroll 事件）才解锁，然后才可点。一般**不必走这条**，用「稍后再说」更快。
- **关闭判定（点完后回读确认）**：`div.ln-mask` 不可见 **且** 页面文本不含「我已阅读并知晓」→ 已关闭；否则说明点击没生效，再尝试 `.ln-close`；仍失败才 handoff 用户手动。
- ⚠️ 弹窗没关时所有填表操作都会白做——填表脚本开头必须先关弹窗并回读确认。

### ② 复用标签页，别开新页
- `context.pages().find(p => p.url().includes("Loo/submit"))` 找已打开的提交页；用户刚点过弹窗的 tab 就是它。
- 每次 execute 都 `newPage()` 会导致用户看 A 页、你填 B 页。

### ③ detail「详细细节」是 UEditor 富文本
- 隐藏的 `textarea[name='detail']` 只是提交载体；**可见的是 UEditor iframe**。
- 直接给 textarea 设值：用户看不到，且**会被编辑器的 sync() 用占位内容覆盖回去**。
- 正确写法（browse evaluate 跑在隔离世界，拿不到 `window.UE`，必须注入 `<script>` 桥接页面主世界）：

```js
await page.evaluate((html) => {
  const sc = document.createElement("script");
  sc.textContent = "(function(){try{var keys=Object.keys(UE.instants||{});var target=null;" +
    "for(var i=0;i<keys.length;i++){var ed=UE.instants[keys[i]];if(ed.textarea&&ed.textarea.name==='detail'){target=ed;break;}}" +
    "if(target){target.ready(function(){target.setContent(" + JSON.stringify(html) + ");if(target.sync)target.sync();document.documentElement.setAttribute('data-ue-len',(target.getContent()||'').length);});" +
    "document.documentElement.setAttribute('data-ue-found','y');}else{document.documentElement.setAttribute('data-ue-found','n');}}catch(e){document.documentElement.setAttribute('data-ue-err',String(e).slice(0,150));}})();";
  document.documentElement.appendChild(sc);
  sc.remove();
}, detailHtml);
// 之后读 documentElement 的 data-ue-found / data-ue-len / data-ue-err 校验
```

### ④ 同名重复元素
- `description` 等字段存在**两个同名实例**（一隐藏一可见）。`querySelector` 只填第一个（隐藏的）→ 用户看到的是空的。
- 统一策略：`querySelectorAll` 遍历**所有**同名实例全部设值；回读时按「可见实例」校验。

### ⑤ 附件——不上传（2026-11-17 决策）
- 上传链路问题太多：accept 限 .rar/.zip（png 被静默拒收）、files.dir 路径限制、多次上传产生重复项、偶发乱码。
- **决策：不再上传附件**。证据全部文字化进「详细细节」（数据包/复现/危害），用户可在提交后于补天页面手动补图。
- 补天规则本就要求截图在详情中「本地上传勿复制粘贴」——那是用户操作，不是 agent 的活。

### ⑥ 回读校验（每轮填写后必做）
- 所有字段按 name 回读长度/内容，下拉按 selectedOptions 回读文本。
- 任何字段不符 → 重填 → 再回读。用户看到的和 DOM 必须一致。

## 提交后的动作

- 记录返回的漏洞编号（补天审核一般 1~3 天）。
- ARTEX2 侧：把结果写回 `finding_submissions` 表（finding_id / vendor_id / platform='butian' / state='submitted' / external_id=漏洞编号）。
- `browse session reset` 清理会话（避免标签残留）。

## 已知厂商映射（示例，随时更新）

| 补天 cid | 厂商 | 收录域名 |
|---|---|---|
| 65358 | 长沙市希尚网络科技有限公司 | jbzyun.cn（聚宝赞；jubaozan.com/cn 同属该公司） |

## 2026-11-17 实战补充（#135/#32 两轮 + #43 多轮迭代沉淀）

### ⑦ 提交必须有验证码——最终动作只能人工
- 程序化 `form.submit()` 会被服务端拒绝：`{"status":0,"info":"验证码不通过~"}`。
- 表单里的验证码控件对 browse 的脚本点击不响应（点击提交锚点无任何网络请求）。
- **正确流程**：AI 填完所有字段 → 用户人工完成验证码并点击「提交漏洞」。
- 这与补天公告「高风险操作必须人工确认、禁止 AI 自主执行」一致——不是缺陷，是合规。

### ⑧ browse execute 环境限制（重要）
- execute 跑在隔离世界：拿不到 `window.UE`，需注入 `<script>` 桥接（见坑位③）。
- 整个脚本含顶层 `await` 时会被包 async 执行，但**不能有嵌套 heredoc/py 注入的 `<<'EOF'`**（shell 扫描器拒绝）。
- `page.on("request")` / `page.on("dialog")` 部分场景不受支持，避免依赖网络监听的逻辑。
- 复杂脚本**先 `node --check` 再执行**；整体包 `(async () => {...})().catch()` 兜错。

### ⑨ 标签页回收与重开（一气呵成模板）
- browse 会把 agent 标签收进「Agents」折叠组并空闲自动关闭——提交页标签随时可能消失（实测：填表脚本首次执行就常因标签已关失败）。
- 每次执行前都要带「找不到就重开」逻辑（`let pg = context.pages().find(); if (!pg) { pg = await context.newPage() + goto + wait }`）。**变量名用 `pg`，绝对不要用 `page`**（见坑位⑬）。
- **重开后弹窗会再次出现 → 走坑位①：程序化点「稍后再说」关闭并回读确认**。只有连 `.ln-close` 都点不掉时才 handoff 用户手动。
- 填完 `bringToFront()` 把表单置顶给用户复核（注意：browse 下 bringToFront 可能只是 no-op，加一行提示即可）。

### ⑩ 截图生成的编码坑
- data:URL 里用 `atob()` 解 base64 中文会乱码（Latin-1 处理）。
- **正确**：`encodeURIComponent(html)` 直接内嵌；或服务端 PIL 渲染（DroidSansFallbackFull 支持中文）。
- 大 HTML（>500KB base64）会被 heredoc/命令长度限制卡住——分文件或减内容。

### ⑪ 时效性验证（提交前必做）
- 厂商在持续修复（jbzyun 案例：前端 11-10 移除硬编码、七牛密钥轮换）。
- 提交前必须**重放验证**漏洞当天是否仍成立；已失效的 finding 不要提交（#88/#99 七牛密钥已失效废弃）。
- 复测数据（如 total 增长）本身就是「泄露持续进行」的有力证据，写进报告。

### ⑫ 多轮迭代后文件损坏风险
- 对同一文件反复做字符串手术会积累语法错误（JSX 结构失衡）。
- 页面级大改：先 `git show HEAD:path > /tmp/baseline`，从基线重建，不要在坏文件上继续补丁。

### ⑬ browse execute 注入参数——脚本里禁止重名声明（2026-11-17 实测）
- **致命坑**：`browse execute --file` 会把脚本包进一个带参数的 async 函数，**预置 7 个参数**可用：
  `page`、`context`、`browse`、`ref`、`snapshot`、`handoff`、`state`
  （用 `typeof` 探测确认：`page/context/browse/state` 是 object，`ref/snapshot/handoff` 是 function）。
- 因此脚本里若写 `let/const` 声明上述任一名字，会直接报 `SyntaxError: invalid redefinition of parameter name at execute.js:N:M`，脚本根本不执行——artex agent 严格照模板写时实测踩中 `page` 和 `state` 两次。
- **规避命名**：
  - 页面对象用 `pg`（不要用 `page`）；browse 注入的 `page` 是当前活动页，通常不是提交页，别指望直接用。
  - 回读校验结果用 `check`（不要用 `state`）。
  - 其余保留字 `context/browse/ref/snapshot/handoff` 也不可声明。
- 模板 `scripts/fill_form.js` 已全面改为 `pg` / `check`，并实测跑通（弹窗未关时正确 handoff 停止）。
- 附带：这些注入全局可直接用（如 `context.pages()`、`page.evaluate()`、`snapshot()`、`handoff()`），但不要与它们同名的 `let`/`const`。
- **模板另两个已修 bug（2026-11-17）**：① 删附件段后残留 `return { attach, ... }` 引用未定义变量 → 报 `ReferenceError: attach is not defined`，表现为"字段填了但脚本报错"（agent 会误判为没填）——已改为 `return { ok:true, check }`；② 回读结果变量名 `state` 撞注入参数——已改 `check`。
- **端到端实测**：注入真实 finding 后单脚本跑通——程序化关弹窗（点稍后再说→回读 mask 消失）+ 全字段回填（host/url/title/分类/等级/地区/行业/描述/数据包/修复/详细细节）均成功。若 agent 报告"没自动填信息"，先检查它是否用了旧版模板或脚本在 return 前崩溃。

### ⑭ execute 的 context 可能被重置——用 `--tab` 指定已有标签（2026-11-17 #117 实测）
- 多轮执行后 `context.pages()` 可能只剩 `about:blank`，之前 agent 开的提交页标签不在 context 里；此时 find-or-reopen 会另开新标签 → 公告弹窗重现 → 用户白关一次。
- `browse tabs` 可看到用户浏览器里已打开的提交页标签（含 id）；`browse execute --tab <id> --file x.js` 可直接在该标签上执行。
- 填表脚本据此改造：脚本内 `const pg = page;`（page 由 `--tab` 注入并已 goto 过），删掉 find-or-reopen 段。
- 弹窗判定双条件（mask 可见 OR 文本含「我已阅读并知晓」）在用户手动关弹窗后正常返回未阻塞；注意同名 URL 可能存在两个标签，先逐 tab 探测再操作。
- `type` 下拉用 Playwright selectOption 可能不生效（回读仍「请选择」），改用 JS 设 value + change 事件可靠。

### 已验证可提交清单（task 8，2026-11-17 复测状态）
- ✅ #32 ezEIP AjaxData.ashx 未授权（total 1262 持续增长）
- ✅ #58 middle/login 硬编码口令（服务端复测成立）
- ✅ #43 跨环境令牌伪造→订单越权（需 POST+JSON，GET 会 101）
- ✅ #59 MIDDLE 令牌跨租户 ledger
- ⚠️ #61 sys_user 无盐 MD5（已破解 jbz008=Aa111111、free=12345678；admin 未破；Web 入口未定位——c3tech houtai 与 sys_user 不是同一套账号体系）
- ❌ #88/#99 七牛密钥（已轮换失效）
- ❌ #135 厂商已修复（用户确认不提交）


## 版本移植

- 依赖：browse MCP（`npm install -g @opencode/browse` + 扩展配对一次）、psql 访问 ARTEX2 库。
- 换机器/换版本：拷贝本目录 + browse 配对即可；SKILL.md 里的坑位清单按补天改版更新（先跑回读校验验证）。
