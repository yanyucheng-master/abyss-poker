# 深渊德州开发阶段设计

## Phase 1：系统架构设计

### 分层结构

- `server/server.js`：应用入口，初始化 Express + HTTP + Socket.io
- `socket/socketHandlers.js`：Socket 事件注册与会话接入
- `game/roomManager.js`：房间与玩家生命周期（创建、加入、重连、超时判负）
- `game/gameEngine.js`：对局状态机与行动校验（服务端权威）
- `game/pokerLogic.js`：德州规则辅助逻辑（有效筹码、最小加注、可执行动作）
- `game/handEvaluator.js`：标准 Texas Hold'em 比牌（不比较花色）
- `utils/deck.js`/`utils/shuffle.js`：牌堆构建与洗牌
- `utils/logger.js`：统一日志输出
- `utils/eventBus.js`：事件总线（为技能、被动、特殊模式预留）

### 核心原则

- 客户端只做渲染与输入
- 服务端独占：洗牌、发牌、判定、结算、状态推进
- 模块高内聚低耦合，避免巨大单文件

## Phase 2：数据结构设计

### Player

```js
{
  playerId: "PXXXX",
  reconnectToken: "RTOKEN",
  socketId: "socket-id-or-null",
  name: "玩家名",
  chips: 1000,
  cards: [],
  status: "active", // active/folded/disconnected/out
  totalBet: 0,      // 当前手累计下注
  streetBet: 0,     // 当前街下注
  hasActed: false,
  isAllIn: false,
  disconnectedAt: null,
  skills: [],
  buffs: [],
  relics: [],
  statusEffects: []
}
```

### Room

```js
{
  roomId: "A3B7K9",
  password: null,
  ownerPlayerId: "房主playerId",
  players: [Player, Player],
  phase: "waiting", // waiting/pre_flop/flop/turn/river/showdown/end
  dealerIndex: 0,
  currentPlayerIndex: 0,
  deck: [],
  communityCards: [],
  pot: 0,
  currentBet: 0,
  lastRaiseSize: 50,
  smallBlind: 25,
  bigBlind: 50,
  handNo: 0,
  history: []
}
```

## Phase 3：状态机设计

- `waiting`：等待两名有效玩家在线
- `pre_flop`：发底牌 + 下盲注 + 行动
- `flop`：烧牌 + 发 3 张 + 行动
- `turn`：烧牌 + 发 1 张 + 行动
- `river`：烧牌 + 发 1 张 + 行动
- `showdown`：比牌结算（平分底池，奇数筹码给房主）
- `end`：检查破产、切庄、自动下一手或回 waiting

### 死锁风险控制

- 每次 action 后统一调用 `progressGame()` 判断：
  - 是否只剩一名未弃牌玩家
  - 是否街结束
  - 是否需要 All In 自动发完公共牌
- 严格保证任何有效 action 都能推进状态

## Phase 4：Socket 事件设计

### 客户端 -> 服务端

- `create_room { password? }`
- `join_room { roomId, password?, playerName, playerId?, reconnectToken? }`
- `player_action { action, amount? }`

### 服务端 -> 客户端

- `room_created { roomId }`
- `room_joined { roomId, playerId, reconnectToken, players }`
- `room_state { ... }`
- `game_started { dealer, opponentName }`
- `your_cards { cards }`
- `community_cards { cards, phase }`
- `player_turn { playerId, validActions, minRaise, maxBet, toCall }`
- `action_made { playerId, action, amount, pot, playerChips }`
- `showdown { players, winner, tie, pot }`
- `game_over { winner, reason }`
- `player_disconnected { playerId }`
- `player_reconnected { playerId }`
- `join_error` / `action_error`

## Phase 5：UI 设计

- 登录/创建房间屏
- 等待屏
- 游戏屏

### 演出与反馈

- 发牌入场动画
- 筹码移动动画（下注/结算）
- 当前行动玩家呼吸灯
- All In：震屏 + 红色闪光 + 大字动画
- 底池数字过渡动效
- 胜利/失败视觉反馈

## Phase 6~8 执行策略

- Phase 6：按上述模块编码实现
- Phase 7：Jest + socket.io-client 自动化测试，覆盖核心流程
- Phase 8：更新 README 与 Render 部署说明，确保可交接
