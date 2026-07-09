# Subagent Context

> Compact, generated grounding context. Keep this short; read source only for the requirement and files currently in scope.
> constitution-sha256: acbef3847b25b164f2e7bd7f1e030eaecd474016d58d21d6b0f106e89f0020a1

## Verified project facts

- Name: walker
- Stack: UNKNOWN (技术栈摘要; inspect project source before use)
- Architecture hint: UNKNOWN (架构模式; inspect project source before use) (directory-name inference only; verify against source)
- Build: UNKNOWN (构建命令; inspect project source before use)
- Check: UNKNOWN (静态检查命令; inspect project source before use)
- Test: UNKNOWN (测试命令; inspect project source before use)
- Fact sources: none (inspect source before implementation)

## Grounding priority

1. Current source and command output
2. Approved spec requirement IDs and constitution
3. Handoffs (navigation hints only; verify signatures against source)

If a needed fact is UNKNOWN or conflicts with source, return NEEDS_CONTEXT instead of inventing it.

## Boundaries

- Follow .loom/rules/constitution.md.
- Keep changes scoped to declared requirement IDs and owned files.
- Report changed files, verification receipts, and unresolved risks.
