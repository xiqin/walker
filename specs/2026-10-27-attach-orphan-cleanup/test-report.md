# 测试与调查记录

- REQ-001：`node --test --test-reporter=dot test/message-dispatcher.test.js` 通过；真实临时状态覆盖不完整列表、查询失败、缺失焦点路由的会话、路由成员及消息关联保留；既有测试覆盖正常绑定。
- REQ-002：同一回归集使用固定时间验证两个命令的倒序、分页前筛选、15 天边界和无效时间；另验证指定旧会话绑定。
- REQ-003：只读核查及哈希结果见 `recovery-assessment.md`；未执行恢复操作，后续恢复需另行确认。
- 完整验证：`npm test` 通过，1515 项测试通过、0 失败，包含 lint。
