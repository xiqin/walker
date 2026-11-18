# T3 question夹具隔离范围追加

用户明确回复“批准”，同意扩大T3至`test/integration-feishu-question.test.js`。原因：临时用户目录下完整回归1578项中1572通过、6项在`createFixture`→`createApp`→`OpencodeDriver`构造阶段报`opencode-driver requires serverUrl`，不是标题行为失败，原日志`evidence/full-isolated.log`保留。

源码已确认夹具关闭autostart却未提供serverUrl，驱动只能依赖默认服务记录补足地址；不恢复宿主服务记录、不查看用户库。最小修复仅在测试配置中提供合成地址、当前夹具临时库路径及`readOpencodeService: () => null`。不启动真实服务，不改6项原断言，不改生产代码、配置契约或依赖。

验收运行器增加question模式，以相同隔离口径先保存修复前初始化失败，再保存修复后定向及完整回归新日志。默认用户目录隔离不是OS安全沙箱，不推断历史运行无宿主访问。通过后仍须独立复审，不自动提交、推送、部署或重启。
