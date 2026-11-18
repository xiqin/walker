# T1 驱动验证

## 范围与设计审查

公开边界为已批准的 `OpencodeDriver.getSessionTitle(sessionRef, options)`。生产实现后完成测试前设计审查：复用已有HTTP/进程依赖，只新增标题业务方法；错误构造合并为固定分类帮助函数，避免透传原始异常，无通用策略、测试专用注入或状态写入。没有改动基类、认证、模型和消息读取逻辑。

测试采用真实客户端连接隔离HTTP服务、真实临时SQLite数据库；仅无法稳定制造的权限故障与预算参数捕获使用既有依赖替身。子进程超时用现有execFile边界包装启动真实Node挂起进程，观察进程已终止，不声称诱发真实SQLite内部死锁。测试不读取用户真实标题、不启动OpenCode。

## 命令与实测

- `node --check src/drivers/opencode-driver.js`：退出0。
- `node --test --test-concurrency=1 test/opencode-driver.test.js`：退出0，105项测试通过，0失败/跳过；日志`evidence/driver-tests.log`。
- 隔离工作树基线`npm test`：退出0，1533项通过；不代表本次业务实现已通过完整回归。

## 行为映射

| 行为 | 持久化测试与实测 |
| --- | --- |
| REQ-001-B01 | “按关联地址精确编码ID，沿用认证并读取官方双层响应”；“兼容直接响应且不生成默认标题，拒绝其他会话响应”：真实HTTP读取标题成功。 |
| REQ-001-B03 | 精确编码ID测试；“真实临时SQLite精确转义ID并完整读取中文多行标题且不改数据库”：含SQL注入字符的ID仅命中一条记录，多行标签标题完整，数据库字节未变；不存在文件未创建。展示转义交给T2/T3验证。 |
| REQ-003-B01 | 401/403/404/500四场景；SQLite不存在文件、权限拒绝和挂起：失败受控且不尝试第二来源。完整发送降级由T2/T3验证。 |
| REQ-003-B06 | “真实挂起HTTP在剩余预算内销毁连接”；“SQLite调用包装触发真实子进程挂起，预算到期实际终止”；“剩余预算上限两秒并传入既有客户端”：连接关闭及进程终止均被实际观察，剩余预算与2000毫秒上限生效。 |
| REQ-003-B08 | 认证透传测试、401/403与权限拒绝场景：不启动服务、不切换数据库/HTTP；错误没有原始路径或凭据。 |

全部新增测试位于`test/opencode-driver.test.js`的“OpencodeDriver 关联会话只读标题”组。原始复现探针尚未运行修复后版本；T1完成不等于跨层需求已经验收。

## 独立可错路径与剩余边界

覆盖双层/直接包装、错误身份、畸形结构、空白/非字符串、无ID、耗尽预算、预算上限、HTTP错误与真实超时、SQLite真实精确查询/只读缺文件/模拟权限/真实子进程终止。未对真实用户数据库制造权限故障或长锁；不将模拟权限测试称为实机故障。飞书发送、缓存及销毁由T2/T3承担。

## 独立审查发现与修复复核

首次独立审查`T1-review.md`为FAIL：HTTP跨UTF-8分块损坏标题、非JSON错误响应正文日志泄漏。主执行者复核原反例退出1，记录`http-review-baseline.log`，未豁免阻断。用户随后明确批准`http-scope-amendment.md`，将共享HTTP层及测试加入T1 owns。

修复前完成设计审查及局部重构：选择已有Node标准库StringDecoder保持完整UTF-8流，不堆积额外Buffer数组；安全日志去掉正文预览，不引入业务专用HTTP客户端、请求选项或测试注入。原始字节计数、体积限制、实际销毁定时器及响应形状不变。

- `node --test --test-concurrency=1 test/opencode-driver.test.js test/http-helper.test.js`：退出0，122项通过，0失败/跳过；`evidence/driver-http-fixed.log`。
- `node specs/2026-11-17-feishu-real-session-title/evidence/http-title-review-probe.cjs`：退出0，同口径`titleIntact=true`、`leakedSyntheticMarker=false`；`evidence/http-review-fixed.log`。
- `npx eslint src/core/http-helper.js src/drivers/opencode-driver.js test/http-helper.test.js test/opencode-driver.test.js`：退出0。
- 已运行驱动覆盖率检查，输出`driver-coverage.log`；共享层修复新增真实跨块及字节上限回归，不用旧覆盖率代替新证据。

新增测试覆盖中文/表情分块原文、200/401/403非JSON日志不泄漏、共享层原始字节上限及连接实际关闭。成功响应缺少标题仍返回null，非成功响应保持可分类权限错误；不为测试改写现有空标题契约。

上述新证据进一步覆盖REQ-001-B01/B03及REQ-003-B01/B06/B08；原失败报告和基线不覆盖，独立复审结果另存T1-review-round2.md。

## 历史守卫协调与完整回归

- `T1-review-round2.md` 独立复审PASS，原两项HTTP阻断关闭。
- 首次完整`npm test`真实失败：1551/1552通过，唯一失败是旧移除任务对驱动工作区无改动的断言，日志`http-full-regression.log`保留。定向守卫复现6/7通过，`guard-baseline.log`保留。
- 用户明确批准`guard-scope-amendment.md`，仅移除无diff断言和不再使用的Git帮助代码，原Claude禁接入保护全部保留，未跳过测试或通过提交规避失败。
- `node --test --test-concurrency=1 test/claude-removal-guard.test.js test/opencode-driver.test.js test/http-helper.test.js`：退出0，129项全部通过，日志`guard-driver-fixed.log`。
- `npm test`：退出0，lint通过，1552项全部通过，0失败/跳过；日志`guard-full-regression.log`。本结果仅证明当前T1代码完整回归，不提前验收T2/T3。
