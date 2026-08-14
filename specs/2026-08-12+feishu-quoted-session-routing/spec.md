# 飞书引用回复会话路由

## 背景

同一个飞书聊天可能同时承载多个 Walker 会话。当前入站消息主要按 route 的当前焦点会话投递，无法区分用户引用回复的是哪个机器人消息。当用户引用某条机器人回复继续提问时，消息应该回到该机器人消息所属的会话，而不是被当前聊天焦点误投递到其他会话。

## 目标

- 引用回复优先按被引用飞书消息绑定的 `sessionId` 路由。
- 直接回复继续按当前 route 的 `focusSessionId` 路由。
- 机器人发出的飞书消息统一记录到持久消息索引，供后续 `parentId` 解析。
- 引用路由不得自动切换 route 焦点。
- 旧消息、跨聊天误引用、已删除会话和记录失败必须安全降级。

## 非目标

- 不改变飞书卡片 action 的路由语义；卡片 action 继续使用 action value 中已有的 `routeKey/sessionId`。
- 不使用飞书 `rootId` 作为唯一会话路由依据。
- 不引入外部数据库或迁移流程。
- 不要求恢复 TTL 之外或被上限剪枝的历史机器人消息映射。

## 方案

采用消息级持久索引方案：`SessionService` 持有 `platformMessages.feishu` 映射，将飞书出站消息 ID 绑定到 Walker `sessionId/routeKey/chatId`。入站飞书事件透传 `parentId`，调度器在处理普通文本前先尝试用 `parentId` 解析引用目标；命中后以映射会话和有效 route 投递，不修改焦点。未命中或无引用时保持现有焦点行为，并保留 thread root fallback。

### 入站路由优先级

1. 若事件包含 `parentId` 且该飞书消息存在有效映射，投递到映射会话，`routedBy = quoted-message`。
2. 否则投递到当前 `routeKey` 的焦点会话，`routedBy = route-focus`。
3. 若 thread 模式下当前 route 无焦点，且存在 `rootId/chatId`，回退到 chat root route 的焦点，`routedBy = thread-root-fallback`。
4. 仍未找到会话时发送未绑定提示。

### 出站记录

调度器在飞书发送 API 调用成功后提取返回的消息 ID 并记录映射。记录失败只写日志，不影响用户可见回复。

应记录产生新飞书消息的回复或发送方法，包括文本、Markdown、卡片、进度卡、错误卡、帮助卡、会话列表卡、权限卡等。更新已有卡片的方法不产生新消息时不记录。

### 持久状态

在现有 session state 内新增：

```json
{
  "platformMessages": {
    "feishu": {
      "om_xxx": {
        "sessionId": "session-xxx",
        "routeKey": "feishu:chat:oc_xxx",
        "chatId": "oc_xxx",
        "kind": "replyText",
        "createdAt": "2026-08-12T00:00:00.000Z"
      }
    }
  }
}
```

首版限制每个平台最多保留 5000 条映射，并在记录时剪枝最旧记录。删除会话时清理该会话的消息映射；解析到不存在或已删除会话时返回空并容忍旧状态。

## 需求

### REQ-001 引用回复按被引用消息所属会话投递

当飞书入站文本消息带有 `parentId`，且该 `parentId` 对应已记录的机器人出站消息，调度器必须将消息投递到映射的会话，并使用该会话的有效 route 进行 route lock 和上下文回复。

验收标准：焦点会话为 B 时，引用会话 A 的机器人消息发送普通文本，最终调用 A 的 driver enqueue，回复上下文含 A 的 `sessionId`。

### REQ-002 直接回复按当前焦点会话投递

当飞书入站文本消息没有可解析的 `parentId` 映射时，调度器必须保持现有 route 焦点行为；引用未命中、跨聊天不匹配、会话已删除时均安全降级到焦点或未绑定提示。

验收标准：没有引用或引用无效时不会投递到错误历史会话，不会自动切换 `focusSessionId`。

### REQ-003 持久记录飞书出站消息到会话映射

成功产生新飞书消息的发送路径必须记录 `messageId -> sessionId/routeKey/chatId/kind/createdAt`，支持数组、字符串和飞书响应对象的消息 ID 提取；记录失败不得影响发送成功返回。

验收标准：`replyText` 多 chunk 返回记录所有 message id；`replyCard` 返回字符串记录；记录方法抛错时 `_callFeishu` 仍返回原发送结果。

### REQ-004 飞书事件透传引用上下文

飞书平台层必须把解析出的 `parentId` 放到传给 dispatcher 的 command/text 顶层事件中，保持 `platformEvent` 中字段不丢失。

验收标准：平台 onMessage 收到的 text 与 command 事件均包含顶层 `parentId`。

### REQ-005 映射状态有边界并容忍旧数据

消息映射必须有明确容量上限；删除 session 或解析到无效 session 时不会产生脏路由或异常中断。

验收标准：超过 5000 条后最旧记录被剪枝；删除会话后相关映射不可再解析。

## 测试策略

- 单元测试覆盖 `SessionService` 的记录、解析、chatId 校验、删除清理和容量剪枝。
- 平台测试覆盖 `parentId` 顶层透传。
- 调度器测试覆盖引用命中优先于焦点和 thread fallback、引用未命中降级、出站记录成功和记录失败不影响发送。

## 风险与缓解

- 风险：旧机器人消息没有映射，引用无法命中。缓解：安全降级到焦点行为，不中断使用。
- 风险：跨聊天 messageId 被误用。缓解：解析时校验 `chatId`，不一致则不使用映射。
- 风险：记录逻辑影响出站发送。缓解：记录异常被捕获，仅日志告警。
