# 批次规范：机票退改签 Agent 学习文档（03–10 篇）

本文件是并行写作的唯一格式与风格基线。任何与本文件冲突的个人偏好，以本文件为准。
范例：同目录 `02/02-index.xml`、`02/02-1-method.xml`、`02/02-2-build.xml`、`02/02-3-quiz.xml`，配图 `02/fig-react-vs-graph.svg`、`02/fig-node-flow.svg`、`02/fig-permission-matrix.svg`。动手前先读一遍 02 篇四个文件。

## 一、编号与标题

- 每篇一个父文档 `NN 篇名`，下挂三个子文档 `NN.1 导读与方法`、`NN.2 落地与代码`、`NN.3 自测与追问`。
- 标题里**不要** emoji、不要 🌟、不要「12 个能力篇」这类旧说法、不要手写序号以外的装饰。
- 交叉引用只用新编号体系（01 业务与领域 … 12 面试表达），不要引用旧文件名或旧章节名。

## 二、每篇四份文档的固定骨架

### 父篇 `NN-index.xml`（导读 600–1000 字）
1. 开篇 2–3 段场景化的总述
2. `<h1>本篇解决什么问题</h1>`
3. `<h1>为什么排在这个位置</h1>`（与前一篇、后一篇的关系）
4. `<h1>本篇结构</h1>`：表格，三列「子文档 / 讲什么 / 读完的产出」，列宽 180/380/260
5. `<h1>前置</h1>`
6. `<h1>读完这一篇要能回答</h1>`：3 条，每条带「提示：…」
7. `<h1>一句话结论</h1>`

### `NN-1-method.xml`（结构与取舍）
1. 问题场景（具体到用户说了什么、系统卡在哪）
2. 2–3 种方案对比表，维度固定为「依赖方向 / 可控性 / 调试成本 / 适合场景」
3. 至少一张画板
4. 4–5 条硬规则（`<h1>五条硬规则</h1>` + ol）
5. 常见误用（ul，每条要有「错在哪」）
6. 检查点（ul，5 条可自查的问句）

### `NN-2-build.xml`（落点与代码）
1. 一张画板（架构 / 流程 / 矩阵 / 漏斗均可）
2. 表格：模块 / 职责 / 代码路径 / 状态（列宽 180/250/250/140）
3. 代码落点说明：讲清这些文件为什么在这、依赖方向对不对
4. `<h1>三个过渡实现点，都能在代码里直接验证</h1>`：3 条，每条必须写「验证方式：……」并且是打开文件就能确认的动作
5. 可选：与 GlobexAgent 同维度对比表

### `NN-3-quiz.xml`（自测与追问）
1. `<h1>五道自测</h1>`：表格「题目 / 参考答案要点」，列宽 260/560
2. `<h1>三种典型错误答法</h1>`：表格「错误答法 / 错在哪 / 怎么改」，列宽 200/300/320
3. `<h1>五条面试追问</h1>`：ol，每条给「答法骨架：……」，不给整段标准答案
4. 结尾 `<h1>验收标准</h1>` 一段

## 三、XML 写法（飞书 docx）

- 只能使用：`title`、`p`、`h1`–`h4`、`ul`/`ol`/`li`、`b`、`table`/`colgroup`/`col`/`thead`/`tbody`/`tr`/`th`/`td`、`whiteboard`、`pre`。
- 表格必须有 `colgroup`，列宽合计 **820**（如 180/380/260）。
- 表头 `<th>` 里放 `<p>`，单元格 `<td>` 里也放 `<p>`。
- **不设 `seq` 属性**，不手写编号（标题里的「01.2」这类是标题文本，不是自动编号）。
- `whiteboard` 必须写成**成对标签**：`<whiteboard type="svg" path="@./x.svg"></whiteboard>`。自闭合会报 `cannot contain both path and inline content`。
- 正文里的 `<` `>` `&` 必须转义；文本里尽量不用这三个符号，用「小于」「和」替代。
- 写完必须校验：`{ echo "<root>"; cat x.xml; echo "</root>"; } > /tmp/chk.xml && xmllint --noout /tmp/chk.xml`。

## 四、画板规范（每篇至少 2 张，其中至少 1 张手绘 SVG；建议 3 张）

**视觉基线**（照 `02/fig-react-vs-graph.svg` 与 `docs/wiki-drafts/hexagon.svg`）：
- 白底 `#FFFFFF`；圆角矩形 `rx=7~10`；字号 11–13，标题 18，副标题 12.5（副标题即**图注**，一句话说清这张图回答什么）。
- 单一主色：蓝 `#2563EB`（内部节点用白底 + `#93C5FD` 描边、深蓝文字 `#1E3A8A`）；一种强调色：橙 `#EA580C`（**仅**用于外部系统 / 适配器 / 会超时的环节）。
- 中性色只用 `#0F172A #334155 #475569 #64748B #94A3B8 #CBD5E1 #E2E8F0 #F8FAFC #EFF6FF #FFF7ED`。禁止彩虹色、禁止红绿同时出现。
- 底部可放一条 `#F8FAFC` 脚注条写一句结论（可选）。
- `viewBox` 宽高比必须落在 **4:3 ~ 16:9**（例如 880×560、880×520、880×470 都行）。禁止 8:1 长条，禁止比 4:3 更方的图。
- 所有 `<path>` 必须写 `fill="none"`（否则曲线被填充成黑块），但 `<marker>` 里的三角不要加。
- 禁止 `<filter>`（阴影除外）、`<pattern>`、`<clipPath>`、`<mask>`、`skewX/skewY`。
- 文字用 `<text>`，不要用 `<path>` 排字。中文按 1em = 字号估算宽度，拉丁按 0.56em，务必留 12px 边距。
- 结构上至少要有：标题、副标题（图注）、2–4 个分组区块、连线或矩阵关系。不要通篇「一行矩形 + 一行文字」。

**mermaid**：只在时序/状态流转确实更清楚时使用，且规模要小（`sequenceDiagram` 参与者 ≤6、消息 ≤12；`flowchart` 节点 ≤6 且用 LR）。写进 `.mmd` 文件后用 `<whiteboard type="mermaid" path="@./x.mmd"></whiteboard>`。节点多的流程一律改画 SVG——mermaid 大图会变成 1:1 的方形长图，已经踩过坑。

**每张图后面必须紧跟**：
```
<p><b>读图要点</b></p>
<ul><li>…</li><li>…</li><li>…</li></ul>
```
三条，分别回答：这张图要解决什么问题 / 图里最容易被忽略的细节 / 读到这张图应该改变什么判断。禁止写成「图中有 A、B、C」这种复述。

**预览自检**（可选但推荐）：`"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" --headless=new --disable-gpu --no-sandbox --screenshot=/tmp/x.png --window-size=880,520 --default-background-color=ffffffff "file://<绝对路径>"`，然后看 png。不要用 qlmanage，它会裁切和拉伸，判断不可靠。

## 五、事实与状态口径（不许美化）

- 状态只用三个词：**已落地 / 部分实现 / 未完成**。禁止「基本完成」「接近生产」「已支持」。
- 每条状态判断都要能指到文件或方案段落。指不到就不写。
- 已知事实（可作为写作前提，如需细节自己打开文件核对）：
  - `backend/app/application/orchestration/` 不存在，LangGraph 编排未拆到应用层，**未完成**。
  - 没有 `composition.py` 统一装配根，依赖仍在各处 import 拼接，**未完成**。
  - 没有 `adapters/outbound/qdrant/`、没有 `adapters/outbound/llm/`，向量检索与 LLM 客户端仍是兼容层，**未完成**。
  - `backend/app/domain/ticket/` 只有 `ports.py`（OrderRepository 端口），实体仍在 legacy，**部分实现**。
  - 三个 Agent 是门面类（`application/agents/*.py`），`MainServiceAgent.run_turn` 转发 `air_agent.graph.run_turn`，**部分实现**。
  - checkpoint 仍是 SQLite（`air_agent/graph.py` 的 `SqliteSaver` + `VAR_DIR/checkpoints.db`），**部分实现**。
  - 会员权益核销与报价减免未接入报价，**未完成**（`domain/loyalty` 只有额度模型）。
  - `/api/v1` 15 条路由已落地（`backend/app/api/main.py`、`adapters/inbound/http/*`）。
  - PostgreSQL 模型 / 仓储 / 工作单元已落地（`adapters/outbound/postgres/*`）。
  - Outbox + Redis Streams：`adapters/outbound/redis/{streams,event_bus}.py` + `worker.py`，**部分实现**（回执对账未闭环）。
  - 评测：`application/evaluations.py` + `/api/v1/admin/evaluations/*`，**部分实现**（无独立财务金标准）。
  - Trace：`adapters/outbound/telemetry/tracing.py`，**部分实现**（只有 API/Agent 基础 span，无全链路）。
  - 前端：`frontend/` React 18 + Vite + TS 办理台，另有独立的「规则模式」浏览器内演示。

## 六、交付流程（lark-cli）

二进制（不在 PATH，必须用绝对路径）：
`/Users/cocochimp/Library/Application Support/LarkShell/aha/users/fdb319ab35e7bfd87a2659f2be3487ee/doubao/sandbox_envs_dir/envs/224d5f67-884f-4e3f-b79a-b4d873041077/override_dlcs/bin/lark-cli`
（下文简写 `$L`；每次 Bash 先 `export PATH=/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`）

1. 建父节点：
`$L wiki +node-create --space-id 7706931885456264446 --title "NN 篇名" --as user --format json` → 记 `node_token` 与 `obj_token`。
2. 建三个子节点：加 `--parent-node-token <父 node_token>`。**一次建一个，建完立刻记录 token，不要重复执行同一条命令**（会生成重复节点）。
3. 写内容（在 XML 所在目录执行，`@./` 才能解析）：
`$L docs +update --doc <obj_token> --command overwrite --content "@./NN-index.xml" --doc-format xml --as user --format json`
4. **必须验证**：`$L docs +fetch --doc <obj_token> --as user --format json`，确认 `revision_id` 变了、标题对、`whiteboard` 块数量等于你插入的图数。`docs +update` 有时不返回 stdout，不要以「没有输出」判断失败。
5. 回传：4 个 wiki 链接（`https://my.feishu.cn/wiki/<node_token>`）+ 4 个 obj_token。

## 七、验收

- 每条状态判断有代码位置或方案段落支撑；没有就删。
- 每张图后面有 3 条读图要点，读图要点不复述图面。
- 标题无 emoji；篇号连续；交叉引用只用新编号。
- 四个 XML 都能通过 xmllint 包裹校验；上传后 4 个文档都能 fetch 到内容。
- 父篇 600–1000 字，x.1 / x.2 各 1200 字以上，x.3 表格齐全。
