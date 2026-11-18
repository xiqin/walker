# 历史守卫协调（用户已批准）

完整回归实测1552项中1551通过、1失败，原始日志 `evidence/http-full-regression.log` 保留。唯一失败是历史移除任务要求驱动相对HEAD无改动，该条件与后续合法功能开发冲突，不是Claude接入回归。定向复现 `node --test test/claude-removal-guard.test.js` 同样退出1（6通过/1失败），见 `evidence/guard-baseline.log`。

用户明确批准额外修改 `test/claude-removal-guard.test.js`。本次仅删除无差异断言和仅供它使用的Git调用/基线常量，调整测试名称并解释长期保护语义。驱动存在、禁止Claude符号和已删除模块、禁止真实启动和用户目录读取、历史资料及变更日志检查全部保留。没有跳过、删掉或更改其余6项测试，没有提交来规避失败。

该测试纳入T1 owns；不扩大生产范围，不提交、推送或部署。保留失败证据，成功日志另存；补独立只读复核后关闭T1。
