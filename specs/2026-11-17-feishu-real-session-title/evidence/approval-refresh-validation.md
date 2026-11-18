# 已批准范围追加后的审批恢复校验

## 原因与处理边界

执行阶段结束后，原生压缩请求被`Stale approval detected: approved: plan.md changed`阻断。原审批计划指纹为`a8b99cc0451fffd2f2118c21b2e24ce079cfcf230df988ce9624e41470de76ca`；当前为`3301f7668b252beee6f5962f7273715e9e3ea529de716f5e3b6026b5ba64f3b9`。变化来自已获用户批准的共享HTTP修复、旧守卫协调、question测试隔离范围记录，没有新业务需求。

只读核实已安装Loom的正式入口：`approve()`只允许当前人工gate；`recover()`只允许failed状态恢复到已有步骤；不存在执行阶段原地刷新审批的MCP入口。正确路径是记录当前元数据失败→正式recover到`approved`→用户确认当前完整计划→正式approve更新审批指纹；保留已完成任务和证据，不重跑brainstorming/planning、不重新选择或初始化流水线，不手改`pipeline.state.json`或跳过校验。审批后的既有工作树步骤仅核实现有隔离树，不新建重复工作树。

## 本轮校验

- `loom_validate_plan`：`ok:true`，errors/warnings均空，T1/T2/T3文件、依赖及owns合法。
- `loom_analyze_artifacts`：`ok:true`、status=pass、无findings、blocker_count=0。重新分析当前追加范围，没有修改spec/requirements/plan/tasks/traceability或业务代码。
- 工具仍把required_category_coverage显示为0%；保留该实际输出，不改工具或伪称机器100%。独立只读Node检查逐REQ的required_categories与behavior.category集合，16/16覆盖；其余4项工具覆盖率为100%。这是原有报告展示问题，不豁免缺失行为。
- 独立Node逐文件SHA-256核对：T1/T2交接中的15个产物均与原指纹一致；`spec.md`、`requirements.json`与原approved指纹一致。只允许计划/任务写入归属和完成勾选的获批变化。
- 当前T3独立复审`T3-review-round2.md`确认原R1/R2关闭、16行为及七维审查PASS；完整默认用户目录隔离回归1578/1578，5份报告收据和16行为账本已通过。不重跑或覆盖历史日志。

## 15维跨产物复核

1. 重复需求：三项分别限定标题显示、身份缓存及故障兼容，无新增重复REQ。
2. 歧义需求：追加文件范围不改变既定来源、身份、预算或降级顺序。
3. 欠规格：原spec的3项REQ与requirements一致，原批准文档字节未变。
4. behavior缺失：16项必需类别均有behavior，独立集合检查16/16。
5. task未映射：计划列出的3项任务文件均存在。
6. behavior未映射到task：16项均映射至真实任务，T3全部覆盖。
7. 未知behavior：工具及计划校验无未知引用。
8. 未知requirement：任务只引用原3项REQ。
9. traceability缺REQ/behavior：3项及16项均存在，已有behavior级tests/evidence。
10. traceability未知引用：没有新增REQ/behavior，工具无finding。
11. traceability任务不存在：T1/T2/T3均存在并done。
12. 依赖环：仍为T1→T2→T3，串行无环。
13. owns冲突：追加HTTP/helper测试和旧守卫归T1，question测试归T3，没有交叉独占写入。
14. constitution冲突：仅沿用驱动/调度/飞书展示和既有测试层；追加范围不改生产分层或协议，不将宪章占位当成已核实架构。
15. 非功能遗漏：安全、性能、可观测性和失败恢复仍有原行为及已审持久化测试，不因追加夹具范围而丢失。

## 交接刷新与后续门禁

只对报告为过期的planning、analyze-artifacts、T1和T2交接，通过正式`loom_write_handoff`刷新当前获批计划依据。T1/T2原生产及测试指纹保持不变，历史测试计数仍是历史观察，不追认为隔离合格。原失败证据、旧首审FAIL、原探针和期待值全部保留。

当前完整计划仍需通过正式`approved` gate重新确认，以新的审批记录覆盖旧审批的过期指纹；未获得该gate确认不推进。后续仍须原生压缩、converge及verification，不提交、推送、部署或启动真实服务。
