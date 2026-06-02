# 深渊德州（Abyss Poker）

网页端双人实时联机 Texas Hold'em 游戏 Demo。  
定位为**电子游戏 / 策略对战 / 联机竞技**，不涉及真实货币或博彩业务。

默认端口固定为 `3002`（本地请访问 [http://localhost:3002](http://localhost:3002)）。

---

## 本地启动方法

1. 安装依赖

```bash
npm install
```

2. 启动服务

```bash
npm start
```

3. 打开浏览器：

`http://localhost:3002`

4. 用两个窗口（或一个普通窗口 + 一个无痕窗口）加入同一房间对战。

单机可行性测试：

- 在首页输入昵称后，点击 `单机模式测试（人机）`
- 服务端会自动创建一个 `深渊AI` 对手并立即开局

---

## 项目结构说明

```text
poker-game
├── server
│   └── server.js              # 应用入口（Express + Socket.io）
├── game
│   ├── roomManager.js         # 房间/玩家生命周期与断线重连
│   ├── gameEngine.js          # 状态机与服务端权威结算
│   ├── pokerLogic.js          # 规则辅助逻辑（最小加注/有效筹码等）
│   └── handEvaluator.js       # 标准德州比牌（不比较花色）
├── socket
│   └── socketHandlers.js      # Socket 事件绑定
├── utils
│   ├── deck.js                # 牌堆
│   ├── shuffle.js             # 洗牌
│   ├── logger.js              # 统一日志
│   └── eventBus.js            # 可扩展事件总线
├── public
│   ├── index.html             # 登录/等待/游戏三屏
│   ├── style.css              # 深色霓虹风格样式与演出动画
│   └── client.js              # 前端渲染与 Socket 通信
├── tests                      # Jest 自动化测试
├── docs
│   └── DESIGN_PHASES.md       # Phase 1~8 设计过程文档
├── render.yaml
└── package.json
```

---

## Socket 事件说明

### 客户端 -> 服务端

- `create_room { password? }`
- `create_solo_room { playerName, playerId?, reconnectToken? }`
- `join_room { roomId, password?, playerName, playerId?, reconnectToken? }`
- `player_action { action: "check"|"call"|"raise"|"allin"|"fold", amount? }`

### 服务端 -> 客户端

- `room_created { roomId }`
- `room_joined { roomId, playerId, reconnectToken, players }`
- `room_state { roomId, phase, pot, currentBet, dealer, currentPlayer, communityCards, players }`
- `game_started { dealer, opponentName }`
- `your_cards { cards }`
- `community_cards { cards, phase }`
- `player_turn { playerId, validActions, minRaise, maxBet, toCall }`
- `action_made { playerId, action, amount, pot, playerChips }`
- `showdown { players, winner, tie, pot }`
- `game_over { winner, reason }`
- `player_disconnected { playerId }`
- `player_reconnected { playerId }`
- `join_error { message }`
- `action_error { message }`

---

## 规则实现要点

- 服务端权威：洗牌、发牌、行动合法性、比牌、结算全部在服务端执行
- 标准 Texas Hold'em 比牌：**不比较花色**
- 标准最小加注：`minRaiseTo = currentBet + lastRaiseSize`
- All In 有效筹码：超出对手有效筹码不可继续对该玩家加注
- 平局分池：奇数筹码按需求分配给房主（`ownerPlayerId`）
- 断线重连：`playerId + reconnectToken` 鉴权，超时 5 分钟则整场判负

---

## 自动化测试

运行：

```bash
npm test
```

测试覆盖场景：

- 创建房间
- 加入房间
- 发牌
- Check / Call / Raise / Fold / All In
- Showdown
- 赢家结算与破产结束
- 断线重连
- 断线超时整场判负

---

## Render 部署说明

1. 将项目推送到 GitHub 仓库
2. 在 Render 创建 **New Web Service** 并连接仓库
3. 配置：
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: Free
4. Render 会注入 `PORT`，服务端已使用 `process.env.PORT || 3002`

---

## 常见问题排查

- **访问 `localhost:3000` 报错**  
  本项目端口是 `3002`，请访问 `http://localhost:3002`

- **加入房间失败**  
  检查房间号是否正确、房间是否已满、密码是否一致

- **重连失败**  
  检查本地是否保留了 `playerId/reconnectToken`，或已超过 5 分钟重连窗口

- **操作按钮灰掉**  
  说明当前不是你的行动回合，等待 `player_turn` 广播

---

## 后续扩展建议

- 技能系统（基于 `eventBus` 注入触发器）
- Relic/Buff/状态效果系统（`player.skills/buffs/relics/statusEffects`）
- 赛事模式与旁观模式
- 音频系统与更丰富结算演出
