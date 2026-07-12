# 深渊德州（Abyss Poker）

网页端双人实时联机 Texas Hold'em 游戏。项目采用服务端权威架构，支持标准局、高爆局、人机测试、断线重连、行动倒计时、再来一局和牌堆承诺验证。

本项目定位为电子游戏与策略对战 Demo，不涉及真实货币或博彩业务。

## 本地运行

```bash
npm install
npm start
```

默认地址：`http://localhost:3002`。联机测试请用两个独立浏览器窗口；也可以在大厅创建人机房。

常用命令：

```bash
npm test
npm run simulate:overdrive
```

## 游戏模式

发牌模式与技能模式相互独立：

| 发牌模式 | 技能模式 | 定位 |
|---------|---------|------|
| 标准局 `standard` | 关闭 `off` | 传统双人德州 |
| 高爆局 `overdrive` | 关闭 `off` | 强牌碰撞 |
| 标准局 | 深渊 `abyss` | 常规发牌 + 技能构筑 |
| 高爆局 | 深渊 `abyss` | 高爆牌局 + 技能构筑 |

### 标准局

- 完全随机、未经筛选的 52 张牌堆。
- 洗牌使用 Node.js `crypto` 安全随机源。
- 标准 heads-up No-Limit Texas Hold'em 下注与牌型规则。

### 高爆局

高爆局保留标准下注、筹码和牌型规则，只改变服务端生成初始牌堆的方式：

1. 每手生成默认 500 个完整候选牌局。
2. 检查 52 张牌合法性和唯一性。
3. 计算双方起手潜力、最终牌型、底牌参与、公共牌直接成牌、河牌升级与反超。
4. 排除平局、弱起手、底牌不参与等不合格候选。
5. 按戏剧类型权重和高爆评分，从高分候选池中安全随机选择，而不是固定选择最高分。
6. 最终随机交换 A/B 座位，算法不读取昵称、房主、历史胜率或设备信息。

### 深渊技能（ABYSS）

- 负载上限 8，装备 2–4 个技能，开局前构筑，开局后不可更换。
- 初始深渊能量 4，上限 10；每手恢复 1；摊牌失败者额外 +1（主动弃牌无补偿）。
- 首发 12 技能：被动资源、情报、防御、反制、底牌/牌序/公共牌改写。
- 每手最多成功一次牌面改写；反制窗口由服务器权威计时。
- 高爆局已锁定牌堆后，技能只能在其上抽/烧/移除/零化，不会重新生成候选。
- 牌堆承诺：`SHA-256(handId + dealMode + skillMode + serializedDeck + nonce)`。

候选类型目标权重：

- 强强对抗：35%
- 河牌升级：30%
- 河牌反超：20%
- 极端爆发：15%

若严格候选不足，生成器会依次放宽为“双方至少一对”和“允许河牌影响较弱”；牌唯一、不平局、牌型正确、至少一方顺子以上及双方底牌参与仍是硬约束。最终仍失败时回退到正常安全洗牌，且循环始终有界。

## 高爆评分

```text
score =
  startingHandPotentialA
  + startingHandPotentialB
  + finalHandStrengthA
  + finalHandStrengthB
  + confrontationCloseness
  + riverImpact
  + holeCardParticipation
  + dramaticProfileBonus
  - tieRisk
  - boardPlaysPenalty
  - preflopDominancePenalty
  - extremeCollisionPenalty
  - repeatedPatternPenalty
```

各评分项位于 `game/candidateScorer.js`，均为独立、可测试函数。底牌参与判断会枚举所有与最终牌力等价的最佳五张组合，避免只检查第一个组合造成误判。

## 牌堆承诺

每手开始前，服务端生成 `handId`、随机 `nonce`、模式和完整初始牌堆，并计算：

```text
SHA-256(handId + mode + skillMode + deck.map(card => card.code).join(",") + nonce)
```

开局时只发送 `handId/mode/skillMode/commitment`。该手正式结束后才发送 `nonce` 和完整初始牌堆，客户端使用 Web Crypto 重新计算并显示验证结果。对局过程中不会公开 nonce、完整牌堆或未来公共牌。

## 服务端状态机

```text
waiting
  -> pre_flop
  -> flop
  -> turn
  -> river
  -> showdown
  -> end
       -> 下一手
       -> game_over -> rematch / room_closed
```

- 双人局庄家兼小盲，pre-flop 庄家先行动。
- flop/turn/river 由非庄家先行动。
- 一方 All In 且下注已经匹配时，服务端自动发完公共牌并结算。
- 每个真人行动回合有服务器截止时间；超时可过牌时自动 Check，否则自动 Fold。
- 筹码、行动合法性、发牌和结算只由服务端修改。

## Socket.IO 协议

### 客户端到服务端

- `create_room { password?, playerName, playerId?, reconnectToken?, gameMode, skillMode }`
- `create_solo_room { playerName, playerId?, reconnectToken?, gameMode, skillMode }`
- `join_room { roomId, password?, playerName, playerId?, reconnectToken? }`
- `player_action { action, amount? }`
- `skill:loadout:set { skillIds }`
- `skill:use { skillId, target?, requestId }`
- `skill:counter { requestId, skillId }`
- `skill:choice { ... }`
- `rematch_response { accepted }`
- `leave_room {}`

`gameMode` 为 `standard` 或 `overdrive`；`skillMode` 为 `off` 或 `abyss`。房间创建后模式不可修改。

### 服务端到客户端

房间生命周期：

- `room_created`
- `room_joined`
- `room_state`
- `player_joined`
- `player_reconnected`
- `player_disconnected`
- `player_left`
- `left_room`
- `room_closed`
- `join_error`
- `action_error`

牌局：

- `game_started`
- `your_cards`（仅本人）
- `hand_hint`（仅本人当前已成牌型）
- `community_cards`
- `player_turn`
- `action_made`
- `showdown`
- `hand_result`
- `game_over`
- `rematch_update`
- `rematch_started`

公平验证：

- `hand_commitment { handId, mode, commitment }`
- `hand_reveal { handId, mode, nonce, deck, commitment, profile }`

## 公开房间状态

```js
{
  roomId,
  gameMode,
  phase,
  pot,
  currentBet,
  dealer,
  currentPlayer,
  activePlayerId,
  communityCards,
  players,
  actionDeadline,
  handId,
  deckCommitment,
  overdriveProfile
}
```

`players` 只含公开字段，例如昵称、筹码、本街下注、连接状态、准备状态和 All In 状态；不包含底牌、重连 token 或 socketId。`overdriveProfile` 在对局中只表示协议启用，不泄露候选剧情或未来牌型。

## 断线重连

- 玩家身份由 `playerId + reconnectToken` 共同验证，缺少或错误 token 都会被拒绝。
- 浏览器重新连接后会使用保存的房间号和凭证重新加入。
- 重连恢复模式、筹码、底池、当前下注、公共牌、本人底牌、行动者、剩余时间和牌堆承诺。
- 重连不会重新洗牌或重新生成高爆候选。
- 断线玩家仍是再来一局的必要参与者，在线一方不能单独开启幽灵牌局。

## UI 与可访问性

- 科技霓虹深渊主题，中央能量核心表现底池。
- 桌面端和窄屏均提供完整下注区。
- Call 显示跟注额，Raise 显示最终下注额。
- 提供最小、半池、满池、最大快捷值和加注滑杆。
- All In 使用二次确认。
- 设置支持动画强度、减少动态、音效音量、背景音乐音量、界面缩放和低性能模式。
- 系统同时尊重 `prefers-reduced-motion`。

## 项目结构

```text
server/server.js               Express + Socket.IO 服务
socket/socketHandlers.js       房间、行动、重连与限流事件
game/roomManager.js            房间和玩家生命周期
game/gameEngine.js             服务端权威牌局状态机
game/gameModes.js              发牌模式常量
game/skillModes.js             技能模式常量
game/skillConfig.js            能量/负载配置
game/skills/definitions.js     首发 12 技能定义
game/skills/skillState.js      技能运行时状态
game/skills/skillEngine.js     技能校验、反制、结算
game/candidateScorer.js        高爆候选评分
game/overdriveGenerator.js     高爆生成与分级回退
game/deckCommitment.js         SHA-256 牌堆承诺
game/pokerLogic.js             下注规则
game/handEvaluator.js          标准牌型比较（支持零化排除）
public/                        原生 HTML/CSS/JavaScript 前端
tests/                         Jest 单元与 Socket 集成测试
scripts/simulate-overdrive.js  高爆批量统计
```

## 部署

Render 配置位于 `render.yaml`：

- Build Command：`npm ci`
- Start Command：`npm start`
- Health Check：`/healthz`

房间数据保存在单进程内存中，服务重启会清空；若需要横向扩容，应增加共享状态、Socket.IO adapter 和粘性会话。
