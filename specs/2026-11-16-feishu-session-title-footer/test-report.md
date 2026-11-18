# 会话标题页脚测试报告

## 执行范围

主执行者在独立工作树实现 T1 → T2，未提交、推送或重启服务。
工作树：`C:/Users/tianxiqin/.local/share/opencode/worktree/ee4c5e/feature/2026-11-16-feishu-session-title-footer`。
基线提交：`90cb8161c798f030ec14c1d632a4d83e27b87839`。

## 结果

- 基线：定向 242 项通过；安装锁定依赖后完整检查 1526 项通过。
- 修复独立审查发现的进度卡可选参数错位后：平台、调度器、问题卡和进度卡定向 318 项通过。
- 完整 `npm test`：ESLint、语法检查及 1533 项测试通过。
- `git diff --check` 通过。修改仅两个源文件及其测试。

## 需求与行为覆盖

| 需求 | 行为 | 验证 |
| --- | --- | --- |
| REQ-001 | B01、B04 | 实际发送请求体中标题、模型、上下文顺序正确；显式会话及会话 ID 优先于无关焦点；问题卡发送/更新及进度卡继承标题；备用进度卡创建经四参数适配器验证，省略或保留初始事件均正确 |
| REQ-001 | B02 | 缺失、空白、非字符串及异常 getter 均省略标题，保留旧格式 |
| REQ-001 | B03 | 冻结关联会话，写入与远端查询调用失败即测试失败；无会话系统消息不读取焦点 |
| REQ-002 | B01、B04 | 旧/新格式升级、标题变化、重复替换及标题移除只保留一个页脚；卡片输入和嵌入页脚的正文不变 |
| REQ-002 | B02 | 相同正文在新旧标题页脚下连续完成事件不补发；非尾部及不完整页脚、正文模型文字保持不变 |
| REQ-002 | B03、B05 | 多行与 Unicode 行分隔规范为单行，卡片标题转义 Markdown 与飞书标签，不能注入字段或结构 |

测试均持久化在 `test/feishu-api.test.js` 与 `test/message-dispatcher.test.js`；全部九项 behavior 见 `traceability.json`。
网络仅在既有 HTTP 边界拦截，未访问真实飞书；未宣称客户端实机验收。
标题无效的降级由参数化测试和抛错 getter 触发；不新增保存、恢复或资源生命周期能力，因此相关故障演练不适用。

## 环境提示

当前 Node 22.11.0 低于 ESLint 10 推荐版本；锁定依赖安装提示 8 项既有漏洞（4 中、4 高），测试实际通过。本次未升级依赖或锁文件。

## Evidence Receipt

- evidence-git-tree: `d265bed799f77031409cbaebccdb32d1ad4a10d8`
- evidence-diff-sha256: `92da80b75805718b32e28617526bd9a37029416e11578d2a6e3a29a58c2e37be`
- evidence-command: `node --test test/feishu-api.test.js test/message-dispatcher.test.js test/progress-card.test.js test/question-handler.test.js`
- evidence-exit-code: `0`
- evidence-file: `evidence/targeted.log`
- evidence-sha256: `98b5c61be140d3a758a7aa3240b859f59eafb5782ce8265b803f576543128e2a`

## Evidence Receipt

- evidence-command: `npm test`
- evidence-exit-code: `0`
- evidence-file: `evidence/full.log`
- evidence-sha256: `58672d9202d984a13275d19087f033d7c052a0cdec03a00020efe5154af46857`

verdict: PASS
