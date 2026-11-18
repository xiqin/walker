# HTTP边界修复范围变更（已批准）

用户在展示新增两个文件与修复目的后明确回复“批准”。本次扩展仅处理以下两个阻断，原计划其余约束不变。

## 原因与证据

T1独立审查`evidence/T1-review.md`发现两个阻断，主执行者已用相同真实客户端和隔离HTTP服务复核：

`node specs/2026-11-17-feishu-real-session-title/evidence/http-title-review-probe.cjs`，退出1；`evidence/http-review-baseline.log`实测`titleIntact=false`、`leakedSyntheticMarker=true`。原始飞书问题探针与baseline.json保持不变。

1. `src/core/http-helper.js`逐个Buffer隐式转字符串，UTF-8多字节字符跨块时损坏。不是数据库问题：HTTP标题输入在服务器端正确，驱动结果损坏。
2. 同文件在JSON解析失败时记录bodyPreview，在驱动转换为安全错误之前已输出原始正文。只改驱动catch或日志错误码无法撤回该日志。

这两项都是有效中文标题和不泄漏敏感原文要求的实际依赖路径；新增105项驱动测试通过不能豁免反例失败。

## 待用户批准的最小扩展

- 扩大T1独占修改文件至`src/core/http-helper.js`与`test/http-helper.test.js`，并保留原有驱动及其测试范围。
- 正确流式解码UTF-8，保留原始字节大小计数、响应体限制和实际超时销毁。
- 解析失败只输出安全元数据，不记录原始响应正文；如确需兼容既有诊断，限定标题业务的敏感响应保护，不制造新HTTP客户端或测试专用接口。
- 驱动与共享层持久化回归覆盖中文/表情跨块、401/403非JSON及畸形成功响应不泄漏，既有认证、大小限制和超时语义不得改变。
- 更新T1 owns、reads、plan对应边界及追溯测试证据，新增共享层修复审查检查点；在独立复审通过前不关闭T1、不开始T2。
- 不变更用户需求、插件协议、配置、认证机制、数据库结构；不提交、合并、推送、部署或重启服务。

批准后更新T1写入归属和计划边界，流水线保持executing，T1恢复执行；不回退或重跑已完成阶段。
