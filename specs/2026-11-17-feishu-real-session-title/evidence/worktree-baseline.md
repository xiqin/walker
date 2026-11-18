# 隔离工作树基线

- 用户明确回复“批准”，审批工具返回从 approved 到 git-worktree。
- 工作树：`H:/walker/.worktree/2026-11-17-feishu-real-session-title`。
- 分支：`feature/2026-11-17-feishu-real-session-title`，起点 `db54556bc0be99478114c6c809dc78efa6edc31a`。
- 创建前确认主仓库 `.git` 与 common-dir 相同、位于 main，`.worktree/check` 被忽略。主仓库已有 .loom 和旧规格改动保持不变。
- 未提交本轮规格原样复制28个文件，逐文件SHA-256相同；后续以工作树规格目录为权威续跑位置。
- `npm ci --no-audit --no-fund`：退出0，安装120包；当前Node.js 22.11低于ESLint 10.7支持版本，产生已有依赖引擎警告，没有调整锁文件或依赖。
- `npm test`：退出0，lint成功，1533项测试全部通过，0失败/跳过；完整输出见`evidence/worktree-baseline.log`。
- 尚未修改业务代码，尚未运行修复后探针，不启动真实OpenCode服务，不提交/合并/推送/部署/重启。
- 工作树没有独立CodeGraph索引，工具回落到主仓库索引；后续实现以本工作树源码为准，不运行索引初始化。
