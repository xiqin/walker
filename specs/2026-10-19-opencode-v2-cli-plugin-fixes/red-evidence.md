# T1 修复前失败证据

命令：

```text
node --test --test-name-pattern "完成事件早于新回复进入缓存时不发送旧回复|隐藏字段位于首中尾时按序号回填会错位" test/opencode-v2-cli-plugin.test.js
```

退出码：`1`

结果：`# tests 2`、`# pass 0`、`# fail 2`

## 完成事件早于新回复进入缓存时不发送旧回复

修复前完成事件选中了已缓存的 `msg_old`，请求体包含 `OLD_REPLY_SENTINEL`。

```text
# [walker-bridge] session.idle reporting final {
#   sessionId: 'ses_race',
#   deliveryId: 'del_race',
#   hasActiveDelivery: true,
#   messageId: 'msg_old',
#   eventCount: 2,
#   eventTypes: 'text,done'
# }
not ok 1 - 完成事件早于新回复进入缓存时不发送旧回复
  error: |-
    完成事件早于缓存同步时不得发送旧回复

    true !== false

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: false
  actual: true
  operator: 'strictEqual'
  location: 'test/opencode-v2-cli-plugin.test.js:192:1'
```

## 隐藏字段位于首中尾时按序号回填会错位

修复前按字段序号回填，隐藏字段占位，答案错位，且整数仍是字符串位置上的错误值。

```text
not ok 2 - 隐藏字段位于首中尾时按序号回填会错位
  error: |-
    Expected values to be strictly deep-equal:
    + actual - expected

      {
    +   count: undefined,
    +   hidden_first: '稳妥',
    +   hidden_last: undefined,
    +   hidden_mid: '记下',
    +   mode: '4',
    +   note: undefined,
    +   secret: undefined
    -   count: 4,
    -   mode: 'safe',
    -   note: '记下'
      }
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  operator: 'deepStrictEqual'
  location: 'test/opencode-v2-cli-plugin.test.js:280:1'
```

## 不单独拆测的日志格式分支

空 delivery 拒绝与 session 不匹配走同一个 `bridgeLog(deliveryId, type, stage)`，字段集合与 received、final、report 相同，没有第二种日志格式。空 delivery 只由内部守卫触发，poll 返回的正常 delivery 都带 deliveryId，因此不单独造一条失败路径。安装成功日志只记录 path 和 port，失败文本与成功路径共用同一 redact，不单独拆一种成功脱敏格式。
